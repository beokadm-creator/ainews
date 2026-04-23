import { resolveArticleIdByHeadline, resolveArticleIdByUrl } from './articleResolution';

/**
 * Strips all [N] footnote references from the text
 */
export function stripFootnotes(text: string): string {
  return text.replace(/\[(\d{1,3})\]/g, '');
}

/**
 * Client-side HTML sanitization that mimics the server-side logic
 * but uses DOMParser to safely handle and scope CSS/JS in the browser.
 */
export function sanitizeReportHtml(raw: string, articles: any[] = []) {
  const trimmed = (raw || '').trim();
  let cleaned = trimmed;

  if (trimmed.startsWith('```')) {
    const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
    cleaned = fenceMatch
      ? fenceMatch[1].trim()
      : trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();
  }

  const doctypeIdx = cleaned.search(/<!doctype\s+html/i);
  const fullDoc = doctypeIdx >= 0
    ? cleaned.slice(doctypeIdx).trim()
    : cleaned.search(/<html[\s>]/i) >= 0
      ? cleaned.slice(cleaned.search(/<html[\s>]/i)).trim()
      : cleaned;

  // Scope body/html CSS selectors to .report-html-body to prevent layout bleed into app shell
  const scopedStyles: string[] = [];
  const withoutStyles = fullDoc.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_, attrs, css) => {
    const scoped = css
      .replace(/\bbody\b/g, '.report-html-body')
      .replace(/\bhtml\b/g, '.report-html-body');
    scopedStyles.push(`<style${attrs}>${scoped}</style>`);
    return '';
  });

  // Extract only <body> content (strip html/head/body wrapper tags)
  const bodyMatch = withoutStyles.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : fullDoc;

  // Strip [N] footnote references
  const cleanedBody = stripFootnotes(bodyContent);

  // Basic security sanitization before DOM parsing
  let securedBody = cleanedBody
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<(iframe|object|embed)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>/gi, '');

  // DOM-based post-processing (browser only)
  if (typeof window === 'undefined') {
    return scopedStyles.join('\n') + securedBody;
  }

  const articleMap = new Map<string, any>();
  articles.forEach((article) => {
    if (article?.id) articleMap.set(String(article.id), article);
  });

  const findArticleById = (id?: string | null) => (id ? articleMap.get(String(id)) || null : null);
  const resolveCanonicalHref = (href?: string | null, text?: string | null, articleId?: string | null) => {
    if (!href || href.startsWith('javascript') || href.startsWith('#')) return href || null;

    const directArticle = findArticleById(articleId);
    if (directArticle?.url) return directArticle.url;

    const urlMatchId = resolveArticleIdByUrl(href, articles);
    if (urlMatchId) {
      const matchedArticle = findArticleById(urlMatchId);
      if (matchedArticle?.url) return matchedArticle.url;
    }

    if (text) {
      const headlineMatchId = resolveArticleIdByHeadline(text, articles);
      if (headlineMatchId) {
        const matchedArticle = findArticleById(headlineMatchId);
        if (matchedArticle?.url) return matchedArticle.url;
      }
    }

    return href;
  };

  const parser = new DOMParser();
  const tmpDoc = parser.parseFromString(`<html><body>${securedBody}</body></html>`, 'text/html');

  // H1: Strip inline event handlers and javascript: links
  const walkAndClean = (node: Element) => {
    Array.from(node.attributes).forEach(attr => {
      if (attr.name.toLowerCase().startsWith('on')) {
        node.removeAttribute(attr.name);
      }
    });
    if (node.tagName.toLowerCase() === 'a') {
      const href = node.getAttribute('href');
      if (href && href.trim().toLowerCase().startsWith('javascript:')) {
        node.removeAttribute('href');
      }
    }
    Array.from(node.children).forEach(child => walkAndClean(child));
  };
  walkAndClean(tmpDoc.body);

  // 1. Remove "Vol. X" line from report date header
  tmpDoc.querySelectorAll('.report-date-block').forEach((block) => {
    Array.from(block.children).forEach((child) => {
      if (/^Vol\b/i.test((child.textContent || '').trim())) child.remove();
    });
  });

  // 2. Convert div.article-block → <details> accordion
  tmpDoc.querySelectorAll('div.article-block').forEach((block) => {
    const details = tmpDoc.createElement('details');
    details.className = 'article-block';
    const blockArticleId = (block as HTMLElement).getAttribute('data-article-id');
    if (blockArticleId) {
      details.setAttribute('data-article-id', blockArticleId);
    }

    const summary = tmpDoc.createElement('summary');
    summary.className = 'article-summary-row';

    const titleEl = block.querySelector('.article-title');
    const sectorEl = block.querySelector('.article-sector');
    const titleLink = titleEl?.querySelector('a') as HTMLAnchorElement | null;
    const titleText = (titleLink?.textContent || titleEl?.textContent || '').trim();
    const normalizedTitleHref = resolveCanonicalHref(titleLink?.getAttribute('href'), titleText, blockArticleId);
    if (titleLink && normalizedTitleHref) {
      titleLink.setAttribute('href', normalizedTitleHref);
      if (blockArticleId) titleLink.setAttribute('data-article-id', blockArticleId);
    }
    if (titleEl) summary.appendChild(titleEl.cloneNode(true));
    if (sectorEl) summary.appendChild(sectorEl.cloneNode(true));
    details.appendChild(summary);

    const bodyDiv = tmpDoc.createElement('div');
    bodyDiv.className = 'article-body';
    Array.from(block.children).forEach((child) => {
      const cls = (child as HTMLElement).className || '';
      if (!cls.includes('article-title') && !cls.includes('article-sector')) {
        bodyDiv.appendChild(child.cloneNode(true));
      }
    });

    // 원문 보기 button (uses article URL from title link; onClick interceptor opens modal)
    const href = normalizedTitleHref;
    if (href && !href.startsWith('javascript')) {
      const btn = tmpDoc.createElement('a');
      btn.setAttribute('href', href);
      btn.className = 'article-source-btn';
      btn.textContent = '원문 보기 →';
      // 서버가 div.article-block에 심은 data-article-id를 새 버튼으로 복사
      if (blockArticleId) btn.setAttribute('data-article-id', blockArticleId);
      bodyDiv.appendChild(btn);
    }

    details.appendChild(bodyDiv);
    block.replaceWith(details);
  });

  // 3. For <details class="article-block"> already generated by AI — add 원문 보기 button if missing
  tmpDoc.querySelectorAll('details.article-block').forEach((details) => {
    if (details.querySelector('.article-source-btn')) return;
    const summaryEl = details.querySelector('summary');
    const articleLink = summaryEl?.querySelector('a') as HTMLAnchorElement | null;
    const href = resolveCanonicalHref(
      articleLink?.getAttribute('href'),
      (articleLink?.textContent || summaryEl?.textContent || '').trim(),
      details.getAttribute('data-article-id'),
    );
    if (!href || href.startsWith('javascript')) return;

    if (articleLink) {
      articleLink.setAttribute('href', href);
      const articleId = details.getAttribute('data-article-id');
      if (articleId) articleLink.setAttribute('data-article-id', articleId);
    }

    let bodyDiv = details.querySelector('.article-body') as HTMLElement | null;
    if (!bodyDiv) {
      bodyDiv = tmpDoc.createElement('div');
      bodyDiv.className = 'article-body';
      Array.from(details.children).forEach(child => {
        if (child.tagName.toLowerCase() !== 'summary') {
          bodyDiv!.appendChild(child.cloneNode(true));
          child.remove();
        }
      });
      details.appendChild(bodyDiv);
    }

    const btn = tmpDoc.createElement('a');
    btn.setAttribute('href', href);
    btn.className = 'article-source-btn';
    btn.textContent = '원문 보기 →';
    const blockArticleId = details.getAttribute('data-article-id');
    if (blockArticleId) btn.setAttribute('data-article-id', blockArticleId);
    bodyDiv.appendChild(btn);
  });

  // 4. Normalize known article links while preserving non-matching originals
  tmpDoc.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href');
    const articleId = a.getAttribute('data-article-id');
    const normalizedHref = resolveCanonicalHref(href, (a.textContent || '').trim(), articleId);
    if (normalizedHref && href !== normalizedHref) {
      a.setAttribute('href', normalizedHref);
    }
  });

  // 5. Ensure all article links have target="_blank"
  tmpDoc.querySelectorAll('a').forEach((a) => {
    if (a.getAttribute('href') && !a.getAttribute('href')?.startsWith('#')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // 6. Enhance Reference Table with interactivity
  tmpDoc.querySelectorAll('table.ref-table').forEach((table) => {
    table.querySelectorAll('tr').forEach((tr, rowIndex) => {
      if (rowIndex === 0) return; // Skip header

      const link = tr.querySelector('a') as HTMLAnchorElement | null;
      const headlineCell = tr.querySelector('td:nth-child(3)') || tr.querySelector('td:nth-child(2)');
      const headline = (headlineCell?.textContent || '').trim();
      const href = resolveCanonicalHref(link?.getAttribute('href'), headline, link?.getAttribute('data-article-id')) || '';
      if (!href) return;

      if (link) {
        link.setAttribute('href', href);
      }

      tr.style.cursor = 'pointer';
      tr.classList.add('interactive-ref-row');
      tr.setAttribute('data-href', href);
      const linkArticleId = link?.getAttribute('data-article-id');
      if (linkArticleId) {
        tr.setAttribute('data-article-id', linkArticleId);
      }

      // Set the headline so onClick can match it
      if (headline) {
        tr.setAttribute('data-headline', headline);
      }
    });
  });

  return scopedStyles.join('\n') + tmpDoc.body.innerHTML;
}

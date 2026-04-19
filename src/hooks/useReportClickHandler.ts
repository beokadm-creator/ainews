import { resolveArticleIdByUrl, resolveArticleIdByHeadline } from '@/utils/articleResolution';

export function useReportClickHandler(articles: any[], setPreviewArticle: (article: any) => void) {
  return (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    const target = e.target as HTMLElement;
    if (!articles.length) return;

    // 공통 헬퍼: data-article-id → 직접 ID 조회 (배열 순서 무관)
    const findByDataId = (el: HTMLElement): any | null => {
      const id = el.getAttribute('data-article-id');
      if (!id) return null;
      // 만약 AI가 UUID 대신 "1", "2" 와 같이 번호만 넣은 경우를 완벽하게 처리합니다.
      const numId = parseInt(id, 10);
      if (!isNaN(numId) && String(numId) === id) {
        // AI가 준 번호는 1-based index (e.g. 1, 2, 3...)
        if (numId >= 1 && numId <= articles.length) {
          return articles[numId - 1];
        }
      }
      return articles.find((a) => a.id === id) || null;
    };

    // 1. ref-table 헤드라인 버튼: data-article-id 우선
    const refEl = target.closest('[data-article-ref]') as HTMLElement | null;
    if (refEl) {
      e.preventDefault();
      const byId = findByDataId(refEl);
      if (byId) { setPreviewArticle(byId); return; }
      
      // 폴백: 텍스트 매칭
      const linkText = (refEl.textContent || '').trim();
      if (linkText.length > 1) {
        const resolvedId = resolveArticleIdByHeadline(linkText, articles);
        if (resolvedId) {
          const byTitle = articles.find(a => a.id === resolvedId);
          if (byTitle) { setPreviewArticle(byTitle); return; }
        }
      }
      return;
    }

    // 1-b. table interactive-ref-row (from sanitizeHtml)
    const refRow = target.closest('.interactive-ref-row') as HTMLElement | null;
    if (refRow) {
      e.preventDefault();
      // 우선 data-article-id (서버에서 심은 경우)
      const byId = findByDataId(refRow);
      if (byId) { setPreviewArticle(byId); return; }
      
      // 폴백: sanitizeHtml이 추가한 data-headline 매칭
      const headline = refRow.getAttribute('data-headline');
      if (headline && headline.length > 1) {
        const resolvedId = resolveArticleIdByHeadline(headline, articles);
        if (resolvedId) {
          const byTitle = articles.find(a => a.id === resolvedId);
          if (byTitle) { setPreviewArticle(byTitle); return; }
        }
      }
      
      // 폴백: data-href 매칭
      const href = refRow.getAttribute('data-href');
      if (href) {
        const urlResolvedId = resolveArticleIdByUrl(href, articles);
        if (urlResolvedId) {
          const byUrl = articles.find(a => a.id === urlResolvedId);
          if (byUrl) { setPreviewArticle(byUrl); return; }
        }
        // 다 실패하면 href로 이동
        if (!href.startsWith('javascript')) {
          window.open(href, '_blank');
        }
      }
      return;
    }

    // 2. <a> 링크 (원문 보기 버튼 포함)
    const anchor = (target.tagName === 'A' ? target : target.closest('a')) as HTMLAnchorElement | null;
    if (anchor) {
      e.preventDefault();
      
      const isModalTrigger = anchor.classList.contains('article-source-btn') || anchor.classList.contains('ref-headline-btn');
      
      // 이음 M&A 뉴스 양식에서는 링크가 .article-title 내부에 있고 부모 .article-block에 ID가 있음
      const eumArticleBlock = anchor.closest('.article-block');
      const hasParentId = eumArticleBlock && eumArticleBlock.getAttribute('data-article-id');

      if (isModalTrigger || hasParentId) {
        
        // 2-a. data-article-id (자신 또는 부모에서 탐색)
        const byId = findByDataId(anchor as HTMLElement) || (hasParentId ? findByDataId(eumArticleBlock as HTMLElement) : null);
        if (byId) { setPreviewArticle(byId); return; }
        
        // 2-c. 폴백: URL 매칭
        const href = anchor.href || '';
        const urlResolvedId = resolveArticleIdByUrl(href, articles);
        if (urlResolvedId) {
          const byUrl = articles.find((a) => a.id === urlResolvedId);
          if (byUrl) { setPreviewArticle(byUrl); return; }
        }
        
        // 2-d. 폴백: 제목 텍스트 매칭
        const linkText = (anchor.textContent || '').trim();
        if (linkText.length > 1) {
          const resolvedId = resolveArticleIdByHeadline(linkText, articles);
          if (resolvedId) {
            const byTitle = articles.find(a => a.id === resolvedId);
            if (byTitle) { setPreviewArticle(byTitle); return; }
          }
        }
      }
      
      // 모달 트리거가 아니거나 매칭에 실패한 일반 링크는 새 창에서 열기
      const href = anchor.href || '';
      if (href && !href.startsWith('javascript')) {
        window.open(href, '_blank');
      }
      return;
    }

    // 3. <sup>[N]</sup> 각주 (1-based, AI 생성 패턴)
    const sup = (target.tagName === 'SUP' ? target : target.closest('sup')) as HTMLElement | null;
    if (sup) {
      const text = (sup.textContent || '').trim();
      const match = text.match(/\[?(\d+)\]?/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= 1 && num <= articles.length) {
          e.preventDefault();
          setPreviewArticle(articles[num - 1]);
        }
      }
    }
  };
}

import { ExternalLink, X } from 'lucide-react';
import { formatArticleContentParagraphs, formatArticleDate } from '@/lib/articleContent';

interface ArticlePreviewModalProps {
  article: any;
  onClose: () => void;
}

export function ArticlePreviewModal({ article, onClose }: ArticlePreviewModalProps) {
  if (!article) return null;

  const previewContentParagraphs = formatArticleContentParagraphs(article.content || '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-gray-700/40">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                {article.source}
              </span>
              {formatArticleDate(article.publishedAt) && (
                <span className="text-[11px] text-gray-400">
                  {formatArticleDate(article.publishedAt)}
                </span>
              )}
            </div>
            <h3 className="mt-2 text-base font-bold leading-snug text-gray-900 dark:text-white">
              {article.title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Modal body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {article.summary?.length > 0 && (
            <div className="rounded-xl border border-[#1e3a5f]/15 bg-[#1e3a5f]/[0.04] px-4 py-4 dark:border-[#1e3a5f]/30 dark:bg-[#1e3a5f]/10">
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[#1e3a5f]/70 dark:text-blue-400">
                AI 요약
              </p>
              <div className="space-y-1.5">
                {article.summary.map((line: string, index: number) => (
                  <p key={index} className="flex gap-2 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                    <span className="mt-0.5 shrink-0 text-[#1e3a5f]/40 dark:text-blue-400/60">—</span>
                    {line}
                  </p>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-400">기사 원문</p>
            <div className="space-y-4">
              {previewContentParagraphs.length > 0 ? (
                previewContentParagraphs.map((paragraph: string, index: number) => (
                  <p key={`${article.id}-paragraph-${index}`} className="text-sm leading-7 text-gray-700 dark:text-gray-300">
                    {paragraph}
                  </p>
                ))
              ) : (
                <p className="text-sm leading-7 text-gray-400">원문 전문이 저장되지 않은 기사입니다.</p>
              )}
            </div>
          </div>
        </div>

        {/* Modal footer */}
        {article.url && (
          <div className="border-t border-gray-100 px-6 py-3 dark:border-gray-700/40">
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-xs font-medium text-[#1e3a5f] transition hover:underline dark:text-blue-300"
              onClick={(e) => {
                e.stopPropagation();
                // 명시적 window.open — 이벤트 인터셉트 우회
                e.preventDefault();
                window.open(article.url, '_blank', 'noopener,noreferrer');
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              원문 링크 열기
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

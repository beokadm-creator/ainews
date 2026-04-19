import { format } from 'date-fns';
import { Clock3, Loader2, RefreshCw } from 'lucide-react';

interface ReportListProps {
  outputs: any[];
  selectedOutputId: string | null;
  loading: boolean;
  currentTemplates: { internal?: string; external?: string };
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

export function ReportList({ outputs, selectedOutputId, loading, currentTemplates, onSelect, onRefresh }: ReportListProps) {
  function StatusBadge({ status }: { status: string }) {
    if (status === 'failed') {
      return (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          실패
        </span>
      );
    }
    if (status === 'pending' || status === 'processing') {
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          생성중
        </span>
      );
    }
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
        완료
      </span>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">최근 리포트</span>
        <button
          onClick={onRefresh}
          className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700/40">
          {outputs.map((output) => {
            const isSelected = selectedOutputId === output.id;
            return (
              <button
                key={output.id}
                onClick={() => onSelect(output.id)}
                className={`group w-full px-4 py-3.5 text-left transition ${
                  isSelected
                    ? 'bg-[#1e3a5f]/5 dark:bg-[#1e3a5f]/20'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                }`}
              >
                {isSelected && (
                  <div className="absolute left-0 top-0 h-full w-0.5 rounded-full bg-[#1e3a5f] dark:bg-blue-400" style={{ position: 'relative', display: 'none' }} />
                )}
                <div className="flex items-start justify-between gap-2">
                  <p className={`text-sm font-medium leading-snug ${isSelected ? 'text-[#1e3a5f] dark:text-blue-300' : 'text-gray-900 dark:text-white'}`}>
                    {output.title || '리포트'}
                  </p>
                  <StatusBadge status={output.status || 'completed'} />
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                  <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                    output.serviceMode === 'external'
                      ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'
                      : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                  }`}>
                    {output.serviceMode === 'external' ? '외부' : '내부'}
                  </span>
                  {currentTemplates[output.serviceMode as 'internal' | 'external'] === output.id && (
                    <span className="rounded px-1 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                      TEMPLATE
                    </span>
                  )}
                  {output.createdAt?.toDate && (
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3 w-3" />
                      {format(output.createdAt.toDate(), 'MM.dd HH:mm')}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {outputs.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-gray-400">
              아직 생성된 리포트가 없습니다.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

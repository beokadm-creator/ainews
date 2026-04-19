import { Loader2, Download, RotateCcw, Mail, Send, RefreshCw, Edit3, Sparkles, Save, X } from 'lucide-react';

interface ReportActionBarProps {
  selectedOutput: any;
  isAdmin: boolean;
  editMode: boolean;
  renderHtml: string;
  downloadingFormat: 'pdf' | 'html' | null;
  sending: boolean;
  savingEdit: boolean;
  settingTemplate: boolean;
  currentTemplates: { internal?: string; external?: string };
  onDownload: (format: 'pdf' | 'html') => void;
  onRetry: () => void;
  onEmail: () => void;
  onTelegram: () => void;
  onRegen: () => void;
  onEditToggle: (mode: boolean) => void;
  onSaveEdit: () => void;
  onSetTemplate: (mode: string, isCurrent: boolean) => void;
}

export function ReportActionBar({
  selectedOutput,
  isAdmin,
  editMode,
  renderHtml,
  downloadingFormat,
  sending,
  savingEdit,
  settingTemplate,
  currentTemplates,
  onDownload,
  onRetry,
  onEmail,
  onTelegram,
  onRegen,
  onEditToggle,
  onSaveEdit,
  onSetTemplate,
}: ReportActionBarProps) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {/* Download group */}
      <div className="flex items-center divide-x divide-gray-200 overflow-hidden rounded-lg border border-gray-200 dark:divide-gray-700/40 dark:border-gray-700/60">
        <button
          onClick={() => onDownload('pdf')}
          disabled={downloadingFormat !== null}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-700/40"
        >
          {downloadingFormat === 'pdf' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          PDF
        </button>
        <button
          onClick={() => onDownload('html')}
          disabled={downloadingFormat !== null}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-700/40"
        >
          {downloadingFormat === 'html' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          HTML
        </button>
      </div>

      {selectedOutput.status === 'failed' && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 transition hover:bg-amber-100 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-400"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          다시 시도
        </button>
      )}

      {isAdmin && (
        <>
          <button
            onClick={onEmail}
            disabled={sending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#1e3a5f] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#24456f] disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
            이메일 발송
          </button>
          <button
            onClick={onTelegram}
            disabled={sending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-sky-600 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            텔레그램
          </button>
          {(selectedOutput?.htmlContent || selectedOutput?.rawOutput || selectedOutput?.generatedOutput?.htmlContent) && (
            <button
              onClick={onRegen}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#1e3a5f]/30 bg-[#1e3a5f]/10 px-3 py-2 text-xs font-medium text-[#1e3a5f] transition hover:bg-[#1e3a5f]/20 dark:border-blue-800/40 dark:bg-blue-900/15 dark:text-blue-300"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              리포트 재발행
            </button>
          )}
        </>
      )}
      {renderHtml && !editMode && (
        <button
          onClick={() => onEditToggle(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 transition hover:bg-amber-100 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-400"
        >
          <Edit3 className="h-3.5 w-3.5" />
          내용 편집
        </button>
      )}
      {isAdmin && renderHtml && !editMode && (() => {
        const mode = (selectedOutput?.serviceMode as 'internal' | 'external') || 'internal';
        const targetId = selectedOutput?.generatedOutputId || selectedOutput?.id;
        const isCurrentTemplate = currentTemplates[mode] === targetId;
        return (
          <button
            onClick={() => onSetTemplate(mode, isCurrentTemplate)}
            disabled={settingTemplate}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-500 transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 disabled:opacity-50 dark:border-gray-700/60 dark:text-gray-400 dark:hover:border-amber-700/40 dark:hover:bg-amber-900/20 dark:hover:text-amber-400"
          >
            {settingTemplate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {isCurrentTemplate ? '템플릿 해제' : '스타일 템플릿'}
          </button>
        );
      })()}
      {editMode && (
        <div className="flex items-center gap-2">
          <button
            onClick={onSaveEdit}
            disabled={savingEdit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#1e3a5f] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#24456f] disabled:opacity-50"
          >
            {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            저장
          </button>
          <button
            onClick={() => onEditToggle(false)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-300"
          >
            <X className="h-3.5 w-3.5" />
            취소
          </button>
        </div>
      )}
    </div>
  );
}

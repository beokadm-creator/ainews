import { FallbackProps } from 'react-error-boundary';

export function GlobalErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 py-16 dark:bg-gray-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-lg text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
          <svg className="h-8 w-8 text-red-600 dark:text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-3xl">
          예기치 않은 오류가 발생했습니다
        </h1>
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-left bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-auto max-h-40">
          {error instanceof Error ? error.message : String(error) || '알 수 없는 오류'}
        </p>
        <div className="mt-6 flex justify-center gap-4">
          <button
            onClick={resetErrorBoundary}
            className="inline-flex items-center rounded-md border border-transparent bg-[#d4af37] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#c59f2c] focus:outline-none focus:ring-2 focus:ring-[#d4af37] focus:ring-offset-2"
          >
            다시 시도
          </button>
          <button
            onClick={() => window.location.href = '/'}
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            홈으로 이동
          </button>
        </div>
      </div>
    </div>
  );
}

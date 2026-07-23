"use client";

export interface AppError {
  id: string;
  message: string;
}

export default function ErrorBanner({
  errors,
  onDismiss,
}: {
  errors: AppError[];
  onDismiss: (id: string) => void;
}) {
  if (errors.length === 0) return null;
  return (
    <div className="space-y-2">
      {errors.map((error) => (
        <div
          key={error.id}
          className="flex items-start justify-between gap-3 rounded-2xl border border-cw-darkRed/20 bg-cw-darkRedTint px-4 py-3 text-sm text-cw-darkRed"
          role="alert"
        >
          <span className="break-all">{error.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(error.id)}
            aria-label="닫기"
            className="shrink-0 rounded px-1.5 font-bold text-cw-darkRed transition-colors hover:bg-black/5"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

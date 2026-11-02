// SPDX-License-Identifier: AGPL-3.0-only
// In the style of shadcn/ui, kept to what's used.
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const VARIANTS = {
  primary: 'bg-accent text-surface hover:opacity-90',
  quiet: 'border border-line bg-surface text-ink hover:bg-accent-soft',
};

export function Button({
  variant = 'quiet',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

/** A centred message, for when there's no page to show. */
export function Message({
  title,
  children,
  testId,
}: {
  title: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16" data-testid={testId}>
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="mt-3 space-y-4 text-sm text-muted">{children}</div>
    </div>
  );
}

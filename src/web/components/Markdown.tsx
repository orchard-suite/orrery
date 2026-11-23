// Markdown a person or a tool wrote, drawn in the app's own type. It renders
// to elements, never to raw HTML, and it fetches nothing: an image is left as
// its text.

import ReactMarkdown, { type Components } from 'react-markdown'
import { External } from './ui.tsx'

const HEADING = 'mt-4 text-[13px] font-semibold text-ink-100 first:mt-0'
const SUBHEADING = 'mt-3 text-[13px] font-medium text-ink-200 first:mt-0'

// Headings sit under the panel's own heading, so they start at h3.
const COMPONENTS: Components = {
  h1: ({ children }) => <h3 className={HEADING}>{children}</h3>,
  h2: ({ children }) => <h3 className={HEADING}>{children}</h3>,
  h3: ({ children }) => <h3 className={HEADING}>{children}</h3>,
  h4: ({ children }) => <h4 className={SUBHEADING}>{children}</h4>,
  h5: ({ children }) => <h4 className={SUBHEADING}>{children}</h4>,
  h6: ({ children }) => <h4 className={SUBHEADING}>{children}</h4>,
  p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-1.5 list-disc space-y-1 pl-5 marker:text-ink-500">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1.5 list-decimal space-y-1 pl-5 marker:text-ink-500">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink-100">{children}</strong>,
  em: ({ children }) => <em className="text-ink-300">{children}</em>,
  a: ({ href, children }) => (href ? <External href={href} className="text-orbit">{children}</External> : <>{children}</>),
  code: ({ children, className }) => (className ? <code className={className}>{children}</code> : <code className="break-words rounded-sm bg-ink-850 px-1 py-px font-mono text-[12px] text-ink-100">{children}</code>),
  pre: ({ children }) => <pre className="mt-2 overflow-x-auto rounded-sm border border-ink-800 bg-ink-900 px-3 py-2 font-mono text-[12px] text-ink-200">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="mt-2 border-l-2 border-ink-700 pl-3 text-ink-300">{children}</blockquote>,
  hr: () => <hr className="my-3 border-ink-800" />,
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`text-sm leading-relaxed text-ink-200 [overflow-wrap:anywhere] ${className}`}>
      <ReactMarkdown components={COMPONENTS} disallowedElements={['img']} unwrapDisallowed>
        {text}
      </ReactMarkdown>
    </div>
  )
}

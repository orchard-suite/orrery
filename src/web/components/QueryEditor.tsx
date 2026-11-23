// The editor for a query written as text: the words coloured, what may come
// next offered as it is typed, what a name means shown when it is pointed at,
// and what is wrong marked where it stands. What may come next, and what each
// name is read against, is the parser's answer alone (`readQuery`); what each
// means is `query-complete.ts`. Loaded only when the text is opened, so the
// query page carries none of it otherwise.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from '@codemirror/language'
import { linter, type Diagnostic } from '@codemirror/lint'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, hoverTooltip, keymap, placeholder, type Tooltip } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import type { Blueprint } from '../../shared/model.ts'
import { QUERY_KEYWORDS, readQuery, type Names } from '../../shared/query-text.ts'
import { meaningOf, offers, unknownMarks, type Offer } from '../query-complete.ts'

const KEYWORDS: ReadonlySet<string> = new Set(QUERY_KEYWORDS)

/** Where the word under the cursor starts: a name, a path, or a text or a name in backticks begun. */
const WORD = /(?:"[^"\n]*|`[^`\n]*|[A-Za-z0-9_$:.@<-]*)$/

/** The colours of the language, word by word, as the parser reads them: what follows `from` is a blueprint. */
const language = StreamLanguage.define<{ after: string }>({
  name: 'orrery-query',
  startState: () => ({ after: '' }),
  token(stream: StringStream, state) {
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
    if (stream.match(/^`(?:[^`\\]|\\.)*`?/)) return state.after === 'from' ? 'typeName' : 'variableName'
    if (stream.match(/^-?\d+(?:\.\d+)?[A-Za-z]*/)) return 'number'
    if (stream.match(/^(?:==|!=|>=|<=|>|<|\||=)/)) {
      state.after = ''
      return 'operator'
    }
    if (stream.match(/^[(),]/)) return 'punctuation'
    const word = stream.match(/^[A-Za-z_$][A-Za-z0-9_$:.@<-]*/)
    if (word && typeof word !== 'boolean') {
      const text = word[0]
      const was = state.after
      state.after = text
      if (KEYWORDS.has(text) && was !== 'from') return text === 'true' || text === 'false' || text === 'null' ? 'atom' : 'keyword'
      if (was === 'from') return 'typeName'
      if (text.startsWith('$')) return 'atom'
      if (text.startsWith('r:')) return 'propertyName'
      return 'variableName'
    }
    stream.next()
    return null
  },
})

const colours = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--color-ansi-magenta)' },
  { tag: tags.string, color: 'var(--color-green)' },
  { tag: tags.number, color: 'var(--color-amber)' },
  { tag: tags.atom, color: 'var(--color-ansi-cyan)' },
  { tag: tags.typeName, color: 'var(--color-ansi-yellow-bright)', fontWeight: '600' },
  { tag: tags.propertyName, color: 'var(--color-orbit)' },
  { tag: tags.variableName, color: 'var(--color-ink-100)' },
  { tag: tags.operator, color: 'var(--color-ink-300)' },
  { tag: tags.punctuation, color: 'var(--color-ink-300)' },
  { tag: tags.comment, color: 'var(--color-ink-500)', fontStyle: 'italic' },
])

const theme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: 'var(--color-ink-950)', border: '1px solid var(--color-edge)', borderRadius: '6px', color: 'var(--color-ink-100)' },
  '&.cm-focused': { outline: '2px solid var(--color-ink-300)', outlineOffset: '1px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', maxHeight: '480px', minHeight: '96px' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--color-ink-50)' },
  '.cm-line': { padding: '0 10px' },
  '.cm-cursor': { borderLeftColor: 'var(--color-ink-50)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--color-ink-700) !important' },
  '.cm-placeholder': { color: 'var(--color-ink-500)' },
  '.cm-tooltip': { backgroundColor: 'var(--color-ink-900)', border: '1px solid var(--color-edge)', borderRadius: '6px', color: 'var(--color-ink-100)', fontFamily: 'var(--font-sans)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--color-ink-800)', color: 'var(--color-ink-50)' },
  '.cm-completionDetail': { color: 'var(--color-ink-400)', fontStyle: 'normal', marginLeft: '0.8em' },
  '.cm-completionInfo': { padding: '6px 10px', maxWidth: '320px', fontFamily: 'var(--font-sans)', fontSize: '12.5px', color: 'var(--color-ink-200)' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700', color: 'var(--color-ink-50)' },
  '.cm-diagnostic': { fontFamily: 'var(--font-sans)', fontSize: '12.5px', padding: '4px 8px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--color-red)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--color-amber)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--color-red)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--color-amber)', textUnderlineOffset: '3px' },
  '.q-meaning': { padding: '6px 10px', maxWidth: '340px', fontSize: '12.5px', lineHeight: '1.45' },
  '.q-meaning b': { color: 'var(--color-ink-50)', fontWeight: '600' },
  '.q-meaning .q-kind': { color: 'var(--color-ink-400)', marginLeft: '6px' },
  '.q-meaning p': { margin: '3px 0 0', color: 'var(--color-ink-200)' },
})

/** How an offer is listed: CodeMirror's kind for its icon, and its words. */
const TYPES: Readonly<Record<Offer['kind'], string>> = { keyword: 'keyword', operator: 'operator', blueprint: 'class', field: 'property', relation: 'interface', meta: 'constant', column: 'variable', value: 'enum' }
/** Words first, then the names a reader is most likely after. */
const BOOST: Readonly<Record<Offer['kind'], number>> = { value: 4, field: 3, column: 3, blueprint: 3, relation: 2, meta: 1, keyword: 0, operator: -1 }

export interface QueryEditorProps {
  value: string
  onChange: (text: string) => void
  onApply: () => void
  names: Names
  blueprints: readonly Blueprint[]
  describedBy: string
}

export default function QueryEditor({ value, onChange, onApply, names, blueprints, describedBy }: QueryEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The editor is made once; what it reads is kept current through these.
  const live = useRef({ onChange, onApply, names, blueprints })
  live.current = { onChange, onApply, names, blueprints }

  useEffect(() => {
    const complete = (ctx: CompletionContext): CompletionResult | null => {
      const word = ctx.matchBefore(WORD)
      const from = word ? word.from : ctx.pos
      const typed = ctx.state.sliceDoc(from, ctx.pos)
      if (!typed && !ctx.explicit && !/[\s(,|=<>!]$/.test(ctx.state.sliceDoc(Math.max(0, ctx.pos - 1), ctx.pos))) return null
      const { names, blueprints } = live.current
      const options = offers(readQuery(ctx.state.sliceDoc(0, from), names).expected, typed.replace(/^[`"]/, ''), names, blueprints).map(
        (o): Completion => ({ label: o.label, type: TYPES[o.kind], boost: BOOST[o.kind], ...(o.detail ? { detail: o.detail } : {}), ...(o.info ? { info: o.info } : {}), ...(o.kind === 'keyword' ? { apply: `${o.label} ` } : {}) }),
      )
      return options.length ? { from, options, validFor: /^[`"]?[A-Za-z0-9_$:.@<-]*$/ } : null
    }
    const lint = (v: EditorView): Diagnostic[] => {
      const text = v.state.doc.toString()
      const { names, blueprints } = live.current
      const reading = readQuery(text, names)
      const out: Diagnostic[] = unknownMarks(reading.marks, blueprints).map((m) => ({
        from: m.from,
        to: m.to,
        severity: 'warning',
        message: m.kind === 'field' && m.scope.kind === 'column' ? `No column "${m.id}" in this query: name it under columns first` : `Nothing this query reads has "${m.kind === 'field' ? m.id : ''}"`,
      }))
      if ('error' in reading.result) {
        const at = Math.min(reading.result.error.at, text.length)
        const end = text.slice(at).match(/^[^\s,()]+/)?.[0].length ?? 0
        out.push({ from: at, to: Math.min(text.length, at + Math.max(end, 1)), severity: 'error', message: reading.result.error.message })
      }
      return out
    }
    const hover = hoverTooltip((v, pos): Tooltip | null => {
      const { names, blueprints } = live.current
      const mark = readQuery(v.state.doc.toString(), names).marks.find((m) => m.from <= pos && pos <= m.to)
      const said = mark ? meaningOf(mark, blueprints) : undefined
      if (!mark || !said) return null
      return {
        pos: mark.from,
        end: mark.to,
        above: true,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'q-meaning'
          const head = dom.appendChild(document.createElement('div'))
          head.appendChild(document.createElement('b')).textContent = said.title
          const kind = head.appendChild(document.createElement('span'))
          kind.className = 'q-kind'
          kind.textContent = said.kind
          if (said.description) dom.appendChild(document.createElement('p')).textContent = said.description
          return { dom }
        },
      }
    })
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (live.current.onApply(), true) }])),
          history(),
          closeBrackets(),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          language,
          syntaxHighlighting(colours),
          autocompletion({ override: [complete], icons: false, activateOnTyping: true }),
          linter(lint, { delay: 250 }),
          hover,
          placeholder('from Repository\n  | where $status != "green"\ncolumns title, $status'),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'The query as text', 'aria-describedby': describedBy, 'aria-multiline': 'true', spellcheck: 'false' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) live.current.onChange(u.state.doc.toString())
          }),
          theme,
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [])

  // A change made another way writes the text again.
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} />
}

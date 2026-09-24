/**
 * Declaration SHIM for `react` (19.x) — used by tools/dev/typecheck.mjs only when
 * `@types/react` is not installed (no registry access in some build environments).
 *
 * This is NOT the full React typing. It declares, with honest types, exactly the
 * surface WORLDVIEW's UI package and renderer shell use: function components,
 * the hooks below, context, refs, memo/forwardRef, StrictMode/Fragment and a JSX
 * namespace whose intrinsic elements carry reasonable DOM prop types. Replace with
 * `@types/react` as soon as it can be installed; the typecheck script then ignores
 * this file automatically.
 */

// ---- nodes / elements ---------------------------------------------------------

export type Key = string | number | bigint;

export interface ReactElement<
  P = unknown,
  T extends string | JSXElementConstructor<unknown> = string | JSXElementConstructor<unknown>,
> {
  type: T;
  props: P;
  key: string | null;
}

export type JSXElementConstructor<P> = (props: P) => ReactNode;

export interface ReactPortal extends ReactElement {
  children: ReactNode;
}

export type ReactNode =
  ReactElement | string | number | bigint | Iterable<ReactNode> | ReactPortal | boolean | null | undefined;

export type PropsWithChildren<P = unknown> = P & { children?: ReactNode | undefined };

export type FC<P = {}> = (props: P) => ReactNode;
export type FunctionComponent<P = {}> = FC<P>;
export type ComponentType<P = {}> = FC<P>;

export type ElementType<P = unknown> = string | JSXElementConstructor<P>;

export function createElement<P extends object>(
  type: ElementType<P>,
  props?: (P & { key?: Key | null | undefined; ref?: Ref<unknown> | undefined }) | null,
  ...children: ReactNode[]
): ReactElement<P>;
export function isValidElement(value: unknown): value is ReactElement;
export function cloneElement<P>(
  element: ReactElement<P>,
  props?: Partial<P> & { key?: Key | undefined },
  ...children: ReactNode[]
): ReactElement<P>;

export const Fragment: (props: { children?: ReactNode | undefined; key?: Key | undefined }) => ReactNode;
export const StrictMode: (props: { children?: ReactNode | undefined }) => ReactNode;

// ---- refs -----------------------------------------------------------------------

export interface RefObject<T> {
  readonly current: T;
}
export interface MutableRefObject<T> {
  current: T;
}
export type RefCallback<T> = (instance: T | null) => void | (() => void);
export type Ref<T> = RefCallback<T> | RefObject<T | null> | null;

export function useRef<T>(initialValue: T): MutableRefObject<T>;
export function useRef<T>(initialValue: T | null): RefObject<T | null>;
export function useRef<T = undefined>(): MutableRefObject<T | undefined>;

export function forwardRef<T, P = {}>(
  render: (props: P, ref: Ref<T>) => ReactNode,
): (props: P & { ref?: Ref<T> | undefined }) => ReactNode;

// ---- state / effects -------------------------------------------------------------

export type SetStateAction<S> = S | ((prev: S) => S);
export type Dispatch<A> = (value: A) => void;
export type DependencyList = ReadonlyArray<unknown>;
export type EffectCallback = () => void | (() => void);

export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
export function useEffect(effect: EffectCallback, deps?: DependencyList): void;
export function useLayoutEffect(effect: EffectCallback, deps?: DependencyList): void;
export function useMemo<T>(factory: () => T, deps: DependencyList): T;
export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: DependencyList): T;
export function useId(): string;

export type Reducer<S, A> = (prevState: S, action: A) => S;
export type ReducerState<R> = R extends Reducer<infer S, unknown> ? S : never;
export type ReducerAction<R> = R extends Reducer<unknown, infer A> ? A : never;
export function useReducer<S, A>(reducer: Reducer<S, A>, initialState: S): [S, Dispatch<A>];
export function useReducer<S, A, I>(reducer: Reducer<S, A>, initialArg: I, init: (arg: I) => S): [S, Dispatch<A>];

export function useSyncExternalStore<T>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T;

// ---- context ----------------------------------------------------------------------

export interface Provider<T> {
  (props: { value: T; children?: ReactNode | undefined }): ReactNode;
}
export interface Consumer<T> {
  (props: { children: (value: T) => ReactNode }): ReactNode;
}
export interface Context<T> extends Provider<T> {
  Provider: Provider<T>;
  Consumer: Consumer<T>;
  displayName?: string | undefined;
}
export function createContext<T>(defaultValue: T): Context<T>;
export function useContext<T>(context: Context<T>): T;

export function memo<P extends object>(
  component: (props: P) => ReactNode,
  propsAreEqual?: (prev: Readonly<P>, next: Readonly<P>) => boolean,
): (props: P) => ReactNode;

// ---- events --------------------------------------------------------------------------

export interface SyntheticEvent<T = Element, E = Event> {
  nativeEvent: E;
  currentTarget: T;
  target: EventTarget;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  timeStamp: number;
  type: string;
  preventDefault(): void;
  stopPropagation(): void;
  isDefaultPrevented(): boolean;
  isPropagationStopped(): boolean;
}
export interface ChangeEvent<T = Element> extends SyntheticEvent<T> {
  target: EventTarget & T;
}
export interface FormEvent<T = Element> extends SyntheticEvent<T> {}
export interface FocusEvent<T = Element> extends SyntheticEvent<T, globalThis.FocusEvent> {
  relatedTarget: EventTarget | null;
}
export interface KeyboardEvent<T = Element> extends SyntheticEvent<T, globalThis.KeyboardEvent> {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}
export interface MouseEvent<T = Element, E = globalThis.MouseEvent> extends SyntheticEvent<T, E> {
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  relatedTarget: EventTarget | null;
}
export interface PointerEvent<T = Element> extends MouseEvent<T, globalThis.PointerEvent> {
  pointerId: number;
  pointerType: string;
}
export interface WheelEvent<T = Element> extends MouseEvent<T, globalThis.WheelEvent> {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}
export interface UIEvent<T = Element> extends SyntheticEvent<T, globalThis.UIEvent> {}

export type EventHandler<E extends SyntheticEvent<unknown>> = (event: E) => void;
export type ChangeEventHandler<T = Element> = EventHandler<ChangeEvent<T>>;
export type FormEventHandler<T = Element> = EventHandler<FormEvent<T>>;
export type KeyboardEventHandler<T = Element> = EventHandler<KeyboardEvent<T>>;
export type MouseEventHandler<T = Element> = EventHandler<MouseEvent<T>>;
export type PointerEventHandler<T = Element> = EventHandler<PointerEvent<T>>;
export type WheelEventHandler<T = Element> = EventHandler<WheelEvent<T>>;
export type FocusEventHandler<T = Element> = EventHandler<FocusEvent<T>>;
export type UIEventHandler<T = Element> = EventHandler<UIEvent<T>>;

// ---- DOM attributes ---------------------------------------------------------------------

export type CSSProperties = Partial<Record<string, string | number | undefined>>;

export type Booleanish = boolean | 'true' | 'false';

export interface AriaAttributes {
  'aria-activedescendant'?: string | undefined;
  'aria-atomic'?: Booleanish | undefined;
  'aria-busy'?: Booleanish | undefined;
  'aria-checked'?: boolean | 'false' | 'mixed' | 'true' | undefined;
  'aria-controls'?: string | undefined;
  'aria-current'?: boolean | 'page' | 'step' | 'location' | 'date' | 'time' | 'true' | 'false' | undefined;
  'aria-describedby'?: string | undefined;
  'aria-disabled'?: Booleanish | undefined;
  'aria-expanded'?: Booleanish | undefined;
  'aria-haspopup'?: boolean | 'false' | 'true' | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog' | undefined;
  'aria-hidden'?: Booleanish | undefined;
  'aria-invalid'?: boolean | 'false' | 'true' | 'grammar' | 'spelling' | undefined;
  'aria-label'?: string | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-live'?: 'off' | 'assertive' | 'polite' | undefined;
  'aria-modal'?: Booleanish | undefined;
  'aria-multiselectable'?: Booleanish | undefined;
  'aria-orientation'?: 'horizontal' | 'vertical' | undefined;
  'aria-pressed'?: boolean | 'false' | 'mixed' | 'true' | undefined;
  'aria-readonly'?: Booleanish | undefined;
  'aria-required'?: Booleanish | undefined;
  'aria-selected'?: Booleanish | undefined;
  'aria-setsize'?: number | undefined;
  'aria-posinset'?: number | undefined;
  'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other' | undefined;
  'aria-valuemax'?: number | undefined;
  'aria-valuemin'?: number | undefined;
  'aria-valuenow'?: number | undefined;
  'aria-valuetext'?: string | undefined;
}

export interface DOMAttributes<T> {
  children?: ReactNode | undefined;
  dangerouslySetInnerHTML?: { __html: string } | undefined;
  onClick?: MouseEventHandler<T> | undefined;
  onDoubleClick?: MouseEventHandler<T> | undefined;
  onMouseDown?: MouseEventHandler<T> | undefined;
  onMouseUp?: MouseEventHandler<T> | undefined;
  onMouseEnter?: MouseEventHandler<T> | undefined;
  onMouseLeave?: MouseEventHandler<T> | undefined;
  onMouseMove?: MouseEventHandler<T> | undefined;
  onPointerDown?: PointerEventHandler<T> | undefined;
  onPointerMove?: PointerEventHandler<T> | undefined;
  onPointerUp?: PointerEventHandler<T> | undefined;
  onPointerLeave?: PointerEventHandler<T> | undefined;
  onPointerCancel?: PointerEventHandler<T> | undefined;
  onWheel?: WheelEventHandler<T> | undefined;
  onKeyDown?: KeyboardEventHandler<T> | undefined;
  onKeyUp?: KeyboardEventHandler<T> | undefined;
  onFocus?: FocusEventHandler<T> | undefined;
  onBlur?: FocusEventHandler<T> | undefined;
  onChange?: FormEventHandler<T> | undefined;
  onInput?: FormEventHandler<T> | undefined;
  onSubmit?: FormEventHandler<T> | undefined;
  onScroll?: UIEventHandler<T> | undefined;
  onContextMenu?: MouseEventHandler<T> | undefined;
}

export interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
  className?: string | undefined;
  id?: string | undefined;
  style?: CSSProperties | undefined;
  title?: string | undefined;
  role?: string | undefined;
  tabIndex?: number | undefined;
  hidden?: boolean | undefined;
  lang?: string | undefined;
  dir?: string | undefined;
  draggable?: Booleanish | undefined;
  key?: Key | null | undefined;
  ref?: Ref<T> | undefined;
  /** data-* attributes are always allowed. */
  [dataAttribute: `data-${string}`]: string | number | boolean | undefined;
}

export interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {
  type?: 'button' | 'submit' | 'reset' | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  name?: string | undefined;
  value?: string | undefined;
  form?: string | undefined;
}

export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
  type?: string | undefined;
  value?: string | number | readonly string[] | undefined;
  defaultValue?: string | number | undefined;
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  placeholder?: string | undefined;
  name?: string | undefined;
  autoComplete?: string | undefined;
  autoFocus?: boolean | undefined;
  spellCheck?: Booleanish | undefined;
  min?: number | string | undefined;
  max?: number | string | undefined;
  step?: number | string | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  pattern?: string | undefined;
  required?: boolean | undefined;
  list?: string | undefined;
  inputMode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search' | undefined;
  onChange?: ChangeEventHandler<T> | undefined;
}

export interface TextareaHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | undefined;
  defaultValue?: string | undefined;
  rows?: number | undefined;
  cols?: number | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  name?: string | undefined;
  maxLength?: number | undefined;
  onChange?: ChangeEventHandler<T> | undefined;
}

export interface SelectHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | number | readonly string[] | undefined;
  defaultValue?: string | number | undefined;
  disabled?: boolean | undefined;
  multiple?: boolean | undefined;
  name?: string | undefined;
  required?: boolean | undefined;
  onChange?: ChangeEventHandler<T> | undefined;
}

export interface OptionHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | number | undefined;
  disabled?: boolean | undefined;
  selected?: boolean | undefined;
  label?: string | undefined;
}

export interface LabelHTMLAttributes<T> extends HTMLAttributes<T> {
  htmlFor?: string | undefined;
  form?: string | undefined;
}

export interface AnchorHTMLAttributes<T> extends HTMLAttributes<T> {
  href?: string | undefined;
  target?: string | undefined;
  rel?: string | undefined;
  download?: string | boolean | undefined;
}

export interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string | undefined;
  alt?: string | undefined;
  width?: number | string | undefined;
  height?: number | string | undefined;
  loading?: 'eager' | 'lazy' | undefined;
  decoding?: 'async' | 'auto' | 'sync' | undefined;
  onLoad?: EventHandler<SyntheticEvent<T>> | undefined;
  onError?: EventHandler<SyntheticEvent<T>> | undefined;
}

export interface VideoHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string | undefined;
  autoPlay?: boolean | undefined;
  muted?: boolean | undefined;
  loop?: boolean | undefined;
  playsInline?: boolean | undefined;
  controls?: boolean | undefined;
  poster?: string | undefined;
  onError?: EventHandler<SyntheticEvent<T>> | undefined;
}

export interface TableCellHTMLAttributes<T> extends HTMLAttributes<T> {
  colSpan?: number | undefined;
  rowSpan?: number | undefined;
  scope?: string | undefined;
}

export interface FormHTMLAttributes<T> extends HTMLAttributes<T> {
  action?: string | undefined;
  method?: string | undefined;
  autoComplete?: string | undefined;
  noValidate?: boolean | undefined;
}

export interface DetailsHTMLAttributes<T> extends HTMLAttributes<T> {
  open?: boolean | undefined;
  onToggle?: EventHandler<SyntheticEvent<T>> | undefined;
}

export interface ProgressHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: number | undefined;
  max?: number | undefined;
}

export interface DialogHTMLAttributes<T> extends HTMLAttributes<T> {
  open?: boolean | undefined;
}

export interface SVGAttributes<T> extends AriaAttributes, DOMAttributes<T> {
  className?: string | undefined;
  id?: string | undefined;
  style?: CSSProperties | undefined;
  role?: string | undefined;
  key?: Key | null | undefined;
  ref?: Ref<T> | undefined;
  width?: number | string | undefined;
  height?: number | string | undefined;
  viewBox?: string | undefined;
  preserveAspectRatio?: string | undefined;
  vectorEffect?: string | undefined;
  xmlns?: string | undefined;
  fill?: string | undefined;
  fillOpacity?: number | string | undefined;
  fillRule?: 'nonzero' | 'evenodd' | 'inherit' | undefined;
  stroke?: string | undefined;
  strokeWidth?: number | string | undefined;
  strokeLinecap?: 'butt' | 'round' | 'square' | 'inherit' | undefined;
  strokeLinejoin?: 'miter' | 'round' | 'bevel' | 'inherit' | undefined;
  strokeDasharray?: string | number | undefined;
  strokeOpacity?: number | string | undefined;
  opacity?: number | string | undefined;
  d?: string | undefined;
  cx?: number | string | undefined;
  cy?: number | string | undefined;
  r?: number | string | undefined;
  rx?: number | string | undefined;
  ry?: number | string | undefined;
  x?: number | string | undefined;
  y?: number | string | undefined;
  x1?: number | string | undefined;
  y1?: number | string | undefined;
  x2?: number | string | undefined;
  y2?: number | string | undefined;
  points?: string | undefined;
  transform?: string | undefined;
  focusable?: Booleanish | 'auto' | undefined;
  'aria-hidden'?: Booleanish | undefined;
  [dataAttribute: `data-${string}`]: string | number | boolean | undefined;
}

// ---- JSX namespace ---------------------------------------------------------------------------

export namespace JSX {
  type Element = ReactElement;
  /** Valid JSX tag types: intrinsic names or any function component returning a ReactNode (TS ≥ 5.1). */
  type ElementType = string | JSXElementConstructor<any>;
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: Key | null | undefined;
  }
  interface IntrinsicElements {
    a: AnchorHTMLAttributes<HTMLAnchorElement>;
    article: HTMLAttributes<HTMLElement>;
    aside: HTMLAttributes<HTMLElement>;
    b: HTMLAttributes<HTMLElement>;
    button: ButtonHTMLAttributes<HTMLButtonElement>;
    canvas: HTMLAttributes<HTMLCanvasElement> & { width?: number | undefined; height?: number | undefined };
    code: HTMLAttributes<HTMLElement>;
    dd: HTMLAttributes<HTMLElement>;
    details: DetailsHTMLAttributes<HTMLDetailsElement>;
    dialog: DialogHTMLAttributes<HTMLDialogElement>;
    div: HTMLAttributes<HTMLDivElement>;
    dl: HTMLAttributes<HTMLDListElement>;
    dt: HTMLAttributes<HTMLElement>;
    em: HTMLAttributes<HTMLElement>;
    fieldset: HTMLAttributes<HTMLFieldSetElement> & { disabled?: boolean | undefined };
    footer: HTMLAttributes<HTMLElement>;
    form: FormHTMLAttributes<HTMLFormElement>;
    h1: HTMLAttributes<HTMLHeadingElement>;
    h2: HTMLAttributes<HTMLHeadingElement>;
    h3: HTMLAttributes<HTMLHeadingElement>;
    h4: HTMLAttributes<HTMLHeadingElement>;
    header: HTMLAttributes<HTMLElement>;
    hr: HTMLAttributes<HTMLHRElement>;
    img: ImgHTMLAttributes<HTMLImageElement>;
    video: VideoHTMLAttributes<HTMLVideoElement>;
    input: InputHTMLAttributes<HTMLInputElement>;
    figcaption: HTMLAttributes<HTMLElement>;
    figure: HTMLAttributes<HTMLElement>;
    kbd: HTMLAttributes<HTMLElement>;
    label: LabelHTMLAttributes<HTMLLabelElement>;
    legend: HTMLAttributes<HTMLLegendElement>;
    li: HTMLAttributes<HTMLLIElement> & { value?: number | undefined };
    main: HTMLAttributes<HTMLElement>;
    nav: HTMLAttributes<HTMLElement>;
    ol: HTMLAttributes<HTMLOListElement>;
    option: OptionHTMLAttributes<HTMLOptionElement>;
    p: HTMLAttributes<HTMLParagraphElement>;
    pre: HTMLAttributes<HTMLPreElement>;
    progress: ProgressHTMLAttributes<HTMLProgressElement>;
    section: HTMLAttributes<HTMLElement>;
    select: SelectHTMLAttributes<HTMLSelectElement>;
    small: HTMLAttributes<HTMLElement>;
    span: HTMLAttributes<HTMLSpanElement>;
    strong: HTMLAttributes<HTMLElement>;
    summary: HTMLAttributes<HTMLElement>;
    table: HTMLAttributes<HTMLTableElement>;
    tbody: HTMLAttributes<HTMLTableSectionElement>;
    td: TableCellHTMLAttributes<HTMLTableCellElement>;
    textarea: TextareaHTMLAttributes<HTMLTextAreaElement>;
    th: TableCellHTMLAttributes<HTMLTableCellElement>;
    thead: HTMLAttributes<HTMLTableSectionElement>;
    time: HTMLAttributes<HTMLTimeElement> & { dateTime?: string | undefined };
    tr: HTMLAttributes<HTMLTableRowElement>;
    ul: HTMLAttributes<HTMLUListElement>;
    svg: SVGAttributes<SVGSVGElement>;
    g: SVGAttributes<SVGGElement>;
    path: SVGAttributes<SVGPathElement>;
    circle: SVGAttributes<SVGCircleElement>;
    line: SVGAttributes<SVGLineElement>;
    rect: SVGAttributes<SVGRectElement>;
    polyline: SVGAttributes<SVGPolylineElement>;
    polygon: SVGAttributes<SVGPolygonElement>;
    title: HTMLAttributes<HTMLTitleElement>;
  }
}

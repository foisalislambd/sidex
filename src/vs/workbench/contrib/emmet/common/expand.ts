/*---------------------------------------------------------------------------------------------
 *  SideX - Emmet abbreviation engine.
 *  Copyright (c) Siden Technologies, Inc. MIT Licensed.
 *
 *  Original implementation of the Emmet abbreviation language (HTML, JSX, and CSS).
 *  The syntax follows the public Emmet abbreviation spec; this file is not a copy of
 *  the Emmet or Code - OSS sources.
 *--------------------------------------------------------------------------------------------*/

export type EmmetSyntax = 'html' | 'css' | 'jsx';

export interface EmmetVariables {
	lang?: string;
	locale?: string;
	charset?: string;
}

export interface ExpandOptions {
	/** Markup or stylesheet syntax used to expand the abbreviation. */
	syntax: EmmetSyntax;
	/** Characters inserted for one nesting level. Defaults to a tab. */
	indent?: string;
	/**
	 * Whitespace already present on the line that holds the abbreviation.
	 * Prefixed to every continuation line so the expansion stays aligned.
	 */
	baseIndent?: string;
	/**
	 * When set, expansions that would steal a normal Tab are rejected:
	 * unknown single words, and single-letter CSS properties with no value.
	 */
	tabTrigger?: boolean;
	variables?: EmmetVariables;
	/**
	 * Selection used by Wrap with Abbreviation. A trailing `*` with no count
	 * repeats the element once per line; otherwise the text is placed in the
	 * innermost element.
	 */
	wrapText?: string;
}

export interface AbbreviationMatch {
	abbreviation: string;
	/** Start column in the line, 0-based. */
	start: number;
}

export interface SourceRange {
	start: number;
	end: number;
}

const HTML_LANGUAGES = new Set([
	'html',
	'xml',
	'xhtml',
	'php',
	'handlebars',
	'razor',
	'vue',
	'svelte',
	'haml',
	'pug',
	'jade',
	'erb',
	'twig',
	'django',
	'blade',
	'ejs',
	'nunjucks'
]);

const CSS_LANGUAGES = new Set(['css', 'scss', 'less', 'sass', 'stylus', 'postcss']);

const JSX_LANGUAGES = new Set(['javascriptreact', 'typescriptreact', 'jsx']);

const BOOLEAN_ATTRS = new Set([
	'allowfullscreen',
	'async',
	'autofocus',
	'autoplay',
	'checked',
	'controls',
	'default',
	'defer',
	'disabled',
	'formnovalidate',
	'hidden',
	'inert',
	'ismap',
	'itemscope',
	'loop',
	'multiple',
	'muted',
	'nomodule',
	'novalidate',
	'open',
	'readonly',
	'required',
	'reversed',
	'selected'
]);

const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr'
]);

const INLINE_TAGS = new Set([
	'a',
	'abbr',
	'acronym',
	'b',
	'bdo',
	'big',
	'br',
	'button',
	'cite',
	'code',
	'dfn',
	'em',
	'i',
	'img',
	'input',
	'kbd',
	'label',
	'map',
	'object',
	'q',
	's',
	'samp',
	'select',
	'small',
	'span',
	'strong',
	'sub',
	'sup',
	'textarea',
	'tt',
	'u',
	'var'
]);

const KNOWN_TAGS = new Set<string>([
	...VOID_TAGS,
	...INLINE_TAGS,
	'address',
	'article',
	'aside',
	'audio',
	'blockquote',
	'body',
	'canvas',
	'caption',
	'colgroup',
	'datalist',
	'dd',
	'del',
	'details',
	'div',
	'dl',
	'dt',
	'fieldset',
	'figcaption',
	'figure',
	'footer',
	'form',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'head',
	'header',
	'html',
	'iframe',
	'ins',
	'legend',
	'li',
	'main',
	'menu',
	'nav',
	'noscript',
	'ol',
	'optgroup',
	'option',
	'output',
	'p',
	'pre',
	'progress',
	'script',
	'section',
	'style',
	'summary',
	'table',
	'tbody',
	'td',
	'template',
	'tfoot',
	'th',
	'thead',
	'time',
	'title',
	'tr',
	'ul',
	'video'
]);

/** Aliases expand once into another abbreviation before attributes from the user are merged. */
const HTML_ALIASES: Readonly<Record<string, string>> = {
	a: 'a[href]',
	'a:link': 'a[href=http://]',
	'a:mail': 'a[href=mailto:]',
	bq: 'blockquote',
	btn: 'button',
	'btn:b': 'button[type=button]',
	'btn:s': 'button[type=submit]',
	'btn:r': 'button[type=reset]',
	hdr: 'header',
	ftr: 'footer',
	art: 'article',
	sect: 'section',
	ifr: 'iframe[src]',
	img: 'img[src alt]',
	input: 'input[type]',
	'input:text': 'input[type=text]',
	'input:password': 'input[type=password]',
	'input:email': 'input[type=email]',
	'input:url': 'input[type=url]',
	'input:search': 'input[type=search]',
	'input:number': 'input[type=number]',
	'input:hidden': 'input[type=hidden]',
	'input:checkbox': 'input[type=checkbox]',
	'input:radio': 'input[type=radio]',
	'input:file': 'input[type=file]',
	'input:submit': 'input[type=submit]',
	'input:button': 'input[type=button]',
	'input:reset': 'input[type=reset]',
	'input:range': 'input[type=range]',
	'input:date': 'input[type=date]',
	'input:color': 'input[type=color]',
	'input:tel': 'input[type=tel]',
	label: 'label[for]',
	link: 'link[rel=stylesheet href]',
	'link:css': 'link[rel=stylesheet href]',
	'link:favicon': 'link[rel="shortcut icon" href]',
	script: 'script[src]',
	'script:src': 'script[src]',
	form: 'form[action]',
	textarea: 'textarea[name cols=30 rows=10]',
	'meta:utf': 'meta[charset=UTF-8]',
	'meta:vp': 'meta[name=viewport content="width=device-width, initial-scale=1.0"]',
	'html:5': '!'
};

const LOREM_WORDS = [
	'lorem',
	'ipsum',
	'dolor',
	'sit',
	'amet',
	'consectetur',
	'adipiscing',
	'elit',
	'sed',
	'do',
	'eiusmod',
	'tempor',
	'incididunt',
	'ut',
	'labore',
	'et',
	'dolore',
	'magna',
	'aliqua',
	'ut',
	'enim',
	'ad',
	'minim',
	'veniam',
	'quis',
	'nostrud',
	'exercitation',
	'ullamco',
	'laboris',
	'nisi',
	'ut',
	'aliquip',
	'ex',
	'ea',
	'commodo',
	'consequat',
	'duis',
	'aute',
	'irure',
	'dolor',
	'in',
	'reprehenderit',
	'in',
	'voluptate',
	'velit',
	'esse',
	'cillum',
	'dolore',
	'eu',
	'fugiat',
	'nulla',
	'pariatur',
	'excepteur',
	'sint',
	'occaecat',
	'cupidatat',
	'non',
	'proident',
	'sunt',
	'in',
	'culpa',
	'qui',
	'officia',
	'deserunt',
	'mollit',
	'anim',
	'id',
	'est',
	'laborum'
];

interface Attr {
	name: string;
	/** Undefined when the abbreviation wrote `name` with `=` but no value. */
	value?: string;
	boolean: boolean;
}

type NodeKind = 'element' | 'group' | 'text' | 'lorem' | 'boilerplate';

interface Elem {
	kind: NodeKind;
	name: string;
	id?: string;
	classes: string[];
	attrs: Attr[];
	text?: string;
	/** 0 means "once per wrapped line". */
	repeat: number;
	children: Elem[];
	/** Whole-selection wrap text injected into the innermost element. */
	injected?: string;
}

interface Num {
	index: number;
	count: number;
}

interface TabState {
	next: number;
	defaults: string[];
}

interface Ctx {
	syntax: EmmetSyntax;
	indent: string;
	baseIndent: string;
	variables: EmmetVariables;
	wrapLines?: string[];
}

const CSS_PROPS: Readonly<Record<string, { prop: string; value?: string }>> = {
	m: { prop: 'margin' },
	mt: { prop: 'margin-top' },
	mr: { prop: 'margin-right' },
	mb: { prop: 'margin-bottom' },
	ml: { prop: 'margin-left' },
	p: { prop: 'padding' },
	pt: { prop: 'padding-top' },
	pr: { prop: 'padding-right' },
	pb: { prop: 'padding-bottom' },
	pl: { prop: 'padding-left' },
	w: { prop: 'width' },
	h: { prop: 'height' },
	maw: { prop: 'max-width' },
	mah: { prop: 'max-height' },
	miw: { prop: 'min-width' },
	mih: { prop: 'min-height' },
	pos: { prop: 'position' },
	t: { prop: 'top' },
	r: { prop: 'right' },
	b: { prop: 'bottom' },
	l: { prop: 'left' },
	fz: { prop: 'font-size' },
	fw: { prop: 'font-weight' },
	fs: { prop: 'font-style' },
	ff: { prop: 'font-family' },
	lh: { prop: 'line-height' },
	ls: { prop: 'letter-spacing' },
	c: { prop: 'color' },
	bg: { prop: 'background' },
	bgc: { prop: 'background-color' },
	bgi: { prop: 'background-image' },
	bgs: { prop: 'background-size' },
	bd: { prop: 'border' },
	bdrs: { prop: 'border-radius' },
	bdc: { prop: 'border-color' },
	bdw: { prop: 'border-width' },
	bds: { prop: 'border-style' },
	d: { prop: 'display' },
	fl: { prop: 'float' },
	cl: { prop: 'clear' },
	ov: { prop: 'overflow' },
	op: { prop: 'opacity' },
	z: { prop: 'z-index' },
	cur: { prop: 'cursor' },
	ta: { prop: 'text-align' },
	td: { prop: 'text-decoration' },
	tt: { prop: 'text-transform' },
	ti: { prop: 'text-indent' },
	va: { prop: 'vertical-align' },
	bxz: { prop: 'box-sizing' },
	bxsh: { prop: 'box-shadow' },
	jc: { prop: 'justify-content' },
	ai: { prop: 'align-items' },
	g: { prop: 'gap' },
	gtc: { prop: 'grid-template-columns' },
	gtr: { prop: 'grid-template-rows' },
	fxd: { prop: 'flex-direction' },
	whs: { prop: 'white-space' },
	trs: { prop: 'transition' },
	trf: { prop: 'transform' },
	v: { prop: 'visibility' },
	db: { prop: 'display', value: 'block' },
	dib: { prop: 'display', value: 'inline-block' },
	di: { prop: 'display', value: 'inline' },
	dn: { prop: 'display', value: 'none' },
	df: { prop: 'display', value: 'flex' },
	dg: { prop: 'display', value: 'grid' },
	dif: { prop: 'display', value: 'inline-flex' },
	posa: { prop: 'position', value: 'absolute' },
	posr: { prop: 'position', value: 'relative' },
	posf: { prop: 'position', value: 'fixed' },
	poss: { prop: 'position', value: 'sticky' },
	fwb: { prop: 'font-weight', value: 'bold' },
	fwn: { prop: 'font-weight', value: 'normal' },
	fsi: { prop: 'font-style', value: 'italic' },
	fsn: { prop: 'font-style', value: 'normal' },
	tac: { prop: 'text-align', value: 'center' },
	tar: { prop: 'text-align', value: 'right' },
	tal: { prop: 'text-align', value: 'left' },
	tdn: { prop: 'text-decoration', value: 'none' },
	tdu: { prop: 'text-decoration', value: 'underline' },
	tdl: { prop: 'text-decoration', value: 'line-through' },
	vam: { prop: 'vertical-align', value: 'middle' },
	vat: { prop: 'vertical-align', value: 'top' },
	vab: { prop: 'vertical-align', value: 'bottom' },
	fll: { prop: 'float', value: 'left' },
	flr: { prop: 'float', value: 'right' },
	fln: { prop: 'float', value: 'none' },
	oh: { prop: 'overflow', value: 'hidden' },
	oa: { prop: 'overflow', value: 'auto' },
	ovv: { prop: 'overflow', value: 'visible' },
	curp: { prop: 'cursor', value: 'pointer' },
	curd: { prop: 'cursor', value: 'default' },
	bxzb: { prop: 'box-sizing', value: 'border-box' },
	bxzc: { prop: 'box-sizing', value: 'content-box' },
	jcc: { prop: 'justify-content', value: 'center' },
	jcsb: { prop: 'justify-content', value: 'space-between' },
	jcsa: { prop: 'justify-content', value: 'space-around' },
	jcfs: { prop: 'justify-content', value: 'flex-start' },
	jcfe: { prop: 'justify-content', value: 'flex-end' },
	aic: { prop: 'align-items', value: 'center' },
	aifs: { prop: 'align-items', value: 'flex-start' },
	aife: { prop: 'align-items', value: 'flex-end' },
	aib: { prop: 'align-items', value: 'baseline' },
	wsn: { prop: 'white-space', value: 'nowrap' },
	wsp: { prop: 'white-space', value: 'pre' },
	wspw: { prop: 'white-space', value: 'pre-wrap' },
	clb: { prop: 'clear', value: 'both' },
	cll: { prop: 'clear', value: 'left' },
	clr: { prop: 'clear', value: 'right' }
};

const CSS_RAW: Readonly<Record<string, string>> = {
	cf: ".cf:before,\n.cf:after {\n\tcontent: ' ';\n\tdisplay: table;\n}\n.cf:after {\n\tclear: both;\n}"
};

const CSS_KEYS = Object.keys(CSS_PROPS).sort((a, b) => b.length - a.length);

/**
 * Map a workbench language id to the Emmet syntax that should expand in it.
 * `includeLanguages` / `excludeLanguages` follow the `emmet.*` settings.
 */
export function syntaxForLanguage(
	languageId: string,
	includeLanguages?: Readonly<Record<string, string>>,
	excludeLanguages?: readonly string[]
): EmmetSyntax | undefined {
	if (excludeLanguages && excludeLanguages.indexOf(languageId) !== -1) {
		return undefined;
	}
	const mapped = includeLanguages?.[languageId] ?? languageId;
	if (excludeLanguages && excludeLanguages.indexOf(mapped) !== -1) {
		return undefined;
	}
	if (JSX_LANGUAGES.has(mapped) || mapped === 'jsx') {
		return 'jsx';
	}
	if (CSS_LANGUAGES.has(mapped) || mapped === 'css') {
		return 'css';
	}
	if (HTML_LANGUAGES.has(mapped) || mapped === 'html') {
		return 'html';
	}
	return undefined;
}

/**
 * Expand `input` to a snippet string (with `$0` / `$1` tab stops), or return
 * undefined when it is not a valid abbreviation in `options.syntax`.
 */
export function expandAbbreviation(input: string, options: ExpandOptions): string | undefined {
	if (!input || /[\r\n]/.test(input)) {
		return undefined;
	}
	if (options.syntax === 'css') {
		return expandCss(input, options);
	}
	return expandMarkup(input, options);
}

/**
 * Longest abbreviation ending at `cursor` (0-based) that expands for `options`.
 * The match must start on a token boundary so a suffix of an ordinary word
 * (the "div" in "foodiv") is not treated as an abbreviation.
 */
export function abbreviationBeforeCursor(
	line: string,
	cursor: number,
	options: ExpandOptions
): AbbreviationMatch | undefined {
	if (cursor <= 0 || cursor > line.length) {
		return undefined;
	}
	const from = Math.max(0, cursor - 200);
	let best: AbbreviationMatch | undefined;
	for (let start = cursor - 1; start >= from; start--) {
		if (!isLeftBoundary(line, start)) {
			continue;
		}
		const abbreviation = line.slice(start, cursor);
		if (expandAbbreviation(abbreviation, options) !== undefined) {
			best = { abbreviation, start };
		}
	}
	return best;
}

export function balanceMarkup(
	source: string,
	selectionStart: number,
	selectionEnd: number,
	direction: 'in' | 'out'
): SourceRange | undefined {
	const roots = parseMarkupTree(source);
	const flat: { node: TagNode; parent?: TagNode }[] = [];
	const visit = (nodes: TagNode[], parent?: TagNode) => {
		for (const node of nodes) {
			flat.push({ node, parent });
			visit(node.children, node);
		}
	};
	visit(roots);

	const contains = (node: TagNode) =>
		node.outerStart <= selectionStart && node.outerEnd >= selectionEnd && node.outerEnd > node.outerStart;
	const candidates = flat.filter(entry => contains(entry.node));
	if (candidates.length === 0) {
		return undefined;
	}
	candidates.sort(
		(a, b) => a.node.outerEnd - a.node.outerStart - (b.node.outerEnd - b.node.outerStart)
	);
	const inner = candidates[0];

	if (direction === 'out') {
		const same = selectionStart === inner.node.outerStart && selectionEnd === inner.node.outerEnd;
		if (!same) {
			return { start: inner.node.outerStart, end: inner.node.outerEnd };
		}
		if (!inner.parent) {
			return undefined;
		}
		return { start: inner.parent.outerStart, end: inner.parent.outerEnd };
	}

	const innerRange = { start: inner.node.innerStart, end: inner.node.innerEnd };
	const sameInner = selectionStart === innerRange.start && selectionEnd === innerRange.end;
	if (!sameInner && innerRange.end > innerRange.start) {
		return innerRange;
	}
	const cursor = selectionStart;
	const child = inner.node.children.find(candidate => candidate.outerStart <= cursor && candidate.outerEnd >= cursor);
	if (!child) {
		return undefined;
	}
	return { start: child.outerStart, end: child.outerEnd };
}

function isLeftBoundary(line: string, start: number): boolean {
	if (start === 0) {
		return true;
	}
	return !/[A-Za-z0-9_#.:[\]='"\-{}>+^*$@()!,/%]/.test(line.charAt(start - 1));
}

function expandMarkup(input: string, options: ExpandOptions): string | undefined {
	if (isRejectedBareWord(input)) {
		return undefined;
	}
	const forest = parseAbbreviation(input);
	if (!forest || forest.length === 0) {
		return undefined;
	}
	const ctx = makeCtx(options);
	if (options.wrapText !== undefined && !forestHasLineRepeat(forest)) {
		const target = findInnermost(forest);
		if (target) {
			target.injected = options.wrapText;
		}
	}
	const state: TabState = { next: 0, defaults: [] };
	const body = renderSequence(forest, 0, true, undefined, ctx, state);
	if (!body) {
		return undefined;
	}
	return applyBaseIndent(finalizeTabs(body, state), ctx.baseIndent);
}

function isRejectedBareWord(input: string): boolean {
	if (!/^[A-Za-z][\w:-]*$/.test(input)) {
		return false;
	}
	if (input === '!' || /^lorem\d*$/i.test(input) || input.indexOf('-') !== -1) {
		return false;
	}
	if (HTML_ALIASES[input] !== undefined || HTML_ALIASES[input.toLowerCase()] !== undefined) {
		return false;
	}
	return !KNOWN_TAGS.has(input.toLowerCase());
}

function forestHasLineRepeat(nodes: Elem[]): boolean {
	for (const node of nodes) {
		if (node.repeat === 0 || forestHasLineRepeat(node.children)) {
			return true;
		}
	}
	return false;
}

function findInnermost(nodes: Elem[]): Elem | undefined {
	let found: Elem | undefined;
	const visit = (el: Elem) => {
		if (el.kind === 'element' || el.kind === 'boilerplate') {
			const nested = el.children.some(child => child.kind === 'element' || child.kind === 'group');
			if (!nested) {
				found = el;
			}
		}
		for (const child of el.children) {
			visit(child);
		}
	};
	for (const node of nodes) {
		visit(node);
	}
	return found;
}

function makeCtx(options: ExpandOptions): Ctx {
	const wrapLines =
		options.wrapText !== undefined ? options.wrapText.split(/\r\n|\n|\r/) : undefined;
	return {
		syntax: options.syntax,
		indent: options.indent ?? '\t',
		baseIndent: options.baseIndent ?? '',
		variables: options.variables ?? {},
		wrapLines
	};
}

// --- parser ----------------------------------------------------------------

class Parser {
	private readonly s: string;
	private readonly allowAlias: boolean;
	private i = 0;

	constructor(source: string, allowAlias = true) {
		this.s = source;
		this.allowAlias = allowAlias;
	}

	parseForest(): Elem[] | undefined {
		const nodes = this.parseSequence('end');
		if (nodes === undefined || this.i < this.s.length) {
			return undefined;
		}
		return nodes;
	}

	private parseSequence(stop: ')' | 'end'): Elem[] | undefined {
		const nodes: Elem[] = [];
		const parentStack: Elem[][] = [nodes];
		let expectElement = true;
		let last: Elem | undefined;

		while (this.i < this.s.length) {
			const ch = this.s.charAt(this.i);
			if (stop === ')' && ch === ')') {
				break;
			}
			if (ch === '+') {
				if (expectElement) {
					return undefined;
				}
				this.i++;
				expectElement = true;
				continue;
			}
			if (ch === '>') {
				if (expectElement || !last || last.kind === 'text' || last.kind === 'lorem') {
					return undefined;
				}
				this.i++;
				parentStack.push(last.children);
				expectElement = true;
				continue;
			}
			if (ch === '^') {
				if (!last) {
					return undefined;
				}
				this.i++;
				if (parentStack.length > 1) {
					parentStack.pop();
				}
				expectElement = true;
				continue;
			}
			if (ch === ' ' || ch === '\t') {
				return undefined;
			}
			const el = ch === '(' ? this.parseGroup() : this.parseElement();
			if (!el) {
				return undefined;
			}
			parentStack[parentStack.length - 1].push(el);
			last = el;
			expectElement = false;
		}

		if (stop === ')') {
			if (this.s.charAt(this.i) !== ')') {
				return undefined;
			}
			this.i++;
		}
		if (expectElement || nodes.length === 0) {
			return undefined;
		}
		return nodes;
	}

	private parseGroup(): Elem | undefined {
		this.i++;
		const children = this.parseSequence(')');
		if (!children) {
			return undefined;
		}
		const group: Elem = {
			kind: 'group',
			name: '',
			classes: [],
			attrs: [],
			repeat: 1,
			children
		};
		if (!this.parseTrailer(group)) {
			return undefined;
		}
		return group;
	}

	private parseElement(): Elem | undefined {
		const start = this.i;
		let name = '';
		if (this.s.charAt(this.i) === '!') {
			name = '!';
			this.i++;
		} else if (/[A-Za-z]/.test(this.s.charAt(this.i))) {
			name = this.readWhile(/[\w:-]/);
		}

		const el: Elem = {
			kind: 'element',
			name,
			classes: [],
			attrs: [],
			repeat: 1,
			children: []
		};

		while (this.i < this.s.length) {
			const ch = this.s.charAt(this.i);
			if (ch === '#') {
				this.i++;
				const id = this.readIdent();
				if (!id) {
					return undefined;
				}
				el.id = id;
				continue;
			}
			if (ch === '.') {
				this.i++;
				const cls = this.readIdent();
				if (!cls) {
					return undefined;
				}
				el.classes.push(cls);
				continue;
			}
			if (ch === '[') {
				if (!this.parseAttrs(el)) {
					return undefined;
				}
				continue;
			}
			break;
		}

		if (!this.parseTrailer(el)) {
			return undefined;
		}

		if (this.i === start) {
			return undefined;
		}

		if (el.kind === 'element' && el.name === '' && el.text !== undefined && !el.id && el.classes.length === 0 && el.attrs.length === 0) {
			el.kind = 'text';
		}

		return this.resolveAlias(el);
	}

	private parseTrailer(el: Elem): boolean {
		if (this.s.charAt(this.i) === '*') {
			this.i++;
			const digits = this.readWhile(/[0-9]/);
			if (digits.length === 0) {
				el.repeat = 0;
			} else {
				const count = parseInt(digits, 10);
				if (!Number.isFinite(count) || count < 1) {
					return false;
				}
				el.repeat = count;
			}
		}
		if (this.s.charAt(this.i) === '{') {
			const text = this.parseText();
			if (text === undefined) {
				return false;
			}
			el.text = text;
		}
		return true;
	}

	private parseText(): string | undefined {
		this.i++;
		let out = '';
		while (this.i < this.s.length) {
			const ch = this.s.charAt(this.i);
			if (ch === '\\' && this.i + 1 < this.s.length) {
				out += this.s.charAt(this.i + 1);
				this.i += 2;
				continue;
			}
			if (ch === '}') {
				this.i++;
				return out;
			}
			out += ch;
			this.i++;
		}
		return undefined;
	}

	private parseAttrs(el: Elem): boolean {
		this.i++;
		while (this.i < this.s.length) {
			this.skipSpaces();
			if (this.s.charAt(this.i) === ']') {
				this.i++;
				return true;
			}
			const name = this.readWhile(/[\w:-]/);
			if (!name) {
				return false;
			}
			this.skipSpaces();
			if (this.s.charAt(this.i) === '=') {
				this.i++;
				this.skipSpaces();
				const value = this.readAttrValue();
				if (value === undefined) {
					return false;
				}
				el.attrs.push({ name, value, boolean: false });
			} else if (BOOLEAN_ATTRS.has(name.toLowerCase())) {
				el.attrs.push({ name, boolean: true });
			} else {
				el.attrs.push({ name, value: '', boolean: false });
			}
		}
		return false;
	}

	private readAttrValue(): string | undefined {
		const quote = this.s.charAt(this.i);
		if (quote === '"' || quote === "'") {
			this.i++;
			let out = '';
			while (this.i < this.s.length) {
				const ch = this.s.charAt(this.i);
				if (ch === '\\' && this.i + 1 < this.s.length) {
					out += this.s.charAt(this.i + 1);
					this.i += 2;
					continue;
				}
				if (ch === quote) {
					this.i++;
					return out;
				}
				out += ch;
				this.i++;
			}
			return undefined;
		}
		return this.readWhile(/[^\s\]]/);
	}

	private resolveAlias(el: Elem): Elem | undefined {
		if (!this.allowAlias || el.kind !== 'element' || el.name === '') {
			return this.finishSpecial(el);
		}
		const alias = HTML_ALIASES[el.name] ?? HTML_ALIASES[el.name.toLowerCase()];
		if (alias === undefined) {
			return this.finishSpecial(el);
		}
		if (alias === '!') {
			el.kind = 'boilerplate';
			el.name = '!';
			return el;
		}
		const parsed = new Parser(alias, false).parseForest();
		if (!parsed || parsed.length !== 1 || parsed[0].kind !== 'element') {
			return undefined;
		}
		const base = parsed[0];
		el.name = base.name;
		el.id = el.id ?? base.id;
		el.classes = base.classes.concat(el.classes);
		el.text = el.text ?? base.text;
		const seen = new Set(el.attrs.map(attr => attr.name));
		const merged: Attr[] = [];
		for (const attr of base.attrs) {
			if (!seen.has(attr.name)) {
				merged.push(attr);
			}
		}
		el.attrs = merged.concat(el.attrs);
		return this.finishSpecial(el);
	}

	private finishSpecial(el: Elem): Elem {
		if (el.name === '!') {
			el.kind = 'boilerplate';
		} else if (el.kind === 'element' && /^lorem\d*$/i.test(el.name) && !el.id && el.classes.length === 0 && el.attrs.length === 0) {
			el.kind = 'lorem';
		}
		return el;
	}

	private readIdent(): string {
		return this.readWhile(/[\w$@-]/);
	}

	private readWhile(pattern: RegExp): string {
		let out = '';
		while (this.i < this.s.length && pattern.test(this.s.charAt(this.i))) {
			out += this.s.charAt(this.i);
			this.i++;
		}
		return out;
	}

	private skipSpaces(): void {
		while (this.s.charAt(this.i) === ' ' || this.s.charAt(this.i) === '\t') {
			this.i++;
		}
	}
}

function parseAbbreviation(input: string): Elem[] | undefined {
	return new Parser(input).parseForest();
}

// --- render ----------------------------------------------------------------

interface Unit {
	el: Elem;
	loopIndex: number;
	loopCount: number;
}

function renderSequence(
	nodes: Elem[],
	level: number,
	parentBlock: boolean,
	parentName: string | undefined,
	ctx: Ctx,
	state: TabState,
	inherited?: Num
): string {
	const units = explode(nodes, ctx);
	if (units.length === 0) {
		return '';
	}
	const rendered = units.map(unit => {
		const numbering = numberingFor(unit, inherited);
		const text = renderUnit(unit.el, numbering, level, parentBlock, parentName, ctx, state);
		const block = text.indexOf('\n') !== -1 || (unit.el.kind === 'element' && isBlockTag(resolveTagName(unit.el, parentName)));
		const textOnly = unit.el.kind === 'text' || unit.el.kind === 'lorem';
		return { text, block, textOnly };
	});

	if (!parentBlock) {
		return rendered.map(piece => piece.text).join('');
	}
	if (rendered.length === 1 && rendered[0].textOnly) {
		return rendered[0].text;
	}

	const lines: string[] = [];
	let buffer = '';
	let previousBlock = true;
	const flush = () => {
		if (buffer.length > 0) {
			lines.push(buffer);
			buffer = '';
			previousBlock = false;
		}
	};
	for (const piece of rendered) {
		const multiline = piece.block || piece.text.indexOf('\n') !== -1;
		if (multiline) {
			flush();
			lines.push(piece.text);
			previousBlock = true;
			continue;
		}
		if (piece.textOnly) {
			if (buffer.length > 0) {
				buffer += piece.text;
			} else if (!previousBlock && lines.length > 0) {
				lines[lines.length - 1] += piece.text;
			} else {
				buffer += piece.text;
			}
			continue;
		}
		if (buffer.length > 0) {
			buffer += piece.text;
			continue;
		}
		flush();
		lines.push(piece.text);
		previousBlock = false;
	}
	flush();
	return lines.join(newline(level, ctx));
}

function explode(nodes: Elem[], ctx: Ctx): Unit[] {
	const units: Unit[] = [];
	for (const el of nodes) {
		let count = el.repeat;
		if (count === 0) {
			count = ctx.wrapLines?.length ?? 1;
		}
		if (count < 1) {
			count = 1;
		}
		for (let index = 0; index < count; index++) {
			units.push({ el, loopIndex: index, loopCount: count });
		}
	}
	return units;
}

function numberingFor(unit: Unit, inherited: Num | undefined): Num {
	const repeating = unit.el.repeat > 1 || unit.el.repeat === 0;
	if (repeating) {
		return { index: unit.loopIndex, count: unit.loopCount };
	}
	return inherited ?? { index: 0, count: 1 };
}

function renderUnit(
	el: Elem,
	numbering: Num,
	level: number,
	parentBlock: boolean,
	parentName: string | undefined,
	ctx: Ctx,
	state: TabState
): string {
	if (el.kind === 'group') {
		return renderSequence(el.children, level, parentBlock, parentName, ctx, state, numbering);
	}
	if (el.kind === 'text') {
		return escapeText(applyNumbering(el.text ?? '', numbering));
	}
	if (el.kind === 'lorem') {
		return loremText(el.name);
	}
	if (el.kind === 'boilerplate') {
		return renderBoilerplate(level, ctx, state);
	}

	const tagName = resolveTagName(el, parentName);
	const lower = tagName.toLowerCase();
	const voidTag = VOID_TAGS.has(lower);
	const open = openTag(tagName, el, numbering, ctx, state, voidTag);
	if (voidTag) {
		return open;
	}
	const close = `</${tagName}>`;
	const injected = injectedText(el, numbering.index, ctx);
	const literal = injected !== undefined ? injected : el.text !== undefined ? applyNumbering(el.text, numbering) : undefined;
	const childStr = renderSequence(el.children, level + 1, isBlockTag(tagName), tagName, ctx, state, numbering);

	if (literal !== undefined && el.children.length === 0) {
		if (!isBlockTag(tagName) || literal.indexOf('\n') === -1) {
			return open + escapeText(literal) + close;
		}
		const lines = literal.split('\n');
		return open + newline(level + 1, ctx) + lines.join(newline(level + 1, ctx)) + newline(level, ctx) + close;
	}
	if (!childStr && literal === undefined) {
		return open + tab(state) + close;
	}
	if (isBlockTag(tagName) && (childStr.indexOf('\n') !== -1 || el.children.some(child => child.kind !== 'text' && child.kind !== 'lorem'))) {
		const inner = literal !== undefined ? escapeText(literal) + childStr : childStr;
		if (inner.indexOf('\n') === -1) {
			return open + newline(level + 1, ctx) + inner + newline(level, ctx) + close;
		}
		return open + newline(level + 1, ctx) + inner + newline(level, ctx) + close;
	}
	if (literal !== undefined) {
		return open + escapeText(literal) + childStr + close;
	}
	return open + childStr + close;
}

function injectedText(el: Elem, index: number, ctx: Ctx): string | undefined {
	if (el.injected !== undefined) {
		return el.injected;
	}
	if (el.repeat === 0 && ctx.wrapLines) {
		return ctx.wrapLines[index] ?? '';
	}
	return undefined;
}

function resolveTagName(el: Elem, parentName: string | undefined): string {
	if (el.name) {
		return el.name;
	}
	return implicitName(parentName);
}

function implicitName(parentName: string | undefined): string {
	switch (parentName?.toLowerCase()) {
		case 'ul':
		case 'ol':
		case 'menu':
			return 'li';
		case 'table':
		case 'tbody':
		case 'thead':
		case 'tfoot':
			return 'tr';
		case 'tr':
			return 'td';
		case 'colgroup':
			return 'col';
		case 'select':
		case 'optgroup':
		case 'datalist':
			return 'option';
		case 'map':
			return 'area';
		case 'dl':
			return 'dt';
		default:
			if (parentName && INLINE_TAGS.has(parentName.toLowerCase())) {
				return 'span';
			}
			return 'div';
	}
}

function isBlockTag(name: string): boolean {
	const lower = name.toLowerCase();
	if (VOID_TAGS.has(lower) || INLINE_TAGS.has(lower)) {
		return false;
	}
	return true;
}

function openTag(tagName: string, el: Elem, numbering: Num, ctx: Ctx, state: TabState, voidTag: boolean): string {
	const attrs = renderAttrs(el, numbering, ctx, state);
	const xhtml = ctx.syntax === 'jsx';
	if (voidTag && xhtml) {
		return `<${tagName}${attrs} />`;
	}
	return `<${tagName}${attrs}>`;
}

function renderAttrs(el: Elem, numbering: Num, ctx: Ctx, state: TabState): string {
	const parts: string[] = [];
	if (el.id) {
		parts.push(attrPair('id', applyNumbering(el.id, numbering), false, state));
	}
	for (const attr of el.attrs) {
		let name = attr.name;
		if (ctx.syntax === 'jsx' && name === 'class') {
			name = 'className';
		}
		if (attr.boolean) {
			parts.push(ctx.syntax === 'jsx' ? `${name}={true}` : name);
			continue;
		}
		parts.push(attrPair(name, applyNumbering(attr.value ?? '', numbering), (attr.value ?? '') === '', state));
	}
	if (el.classes.length > 0) {
		const classAttr = ctx.syntax === 'jsx' ? 'className' : 'class';
		const value = el.classes.map(cls => applyNumbering(cls, numbering)).join(' ');
		parts.push(attrPair(classAttr, value, false, state));
	}
	if (parts.length === 0) {
		return '';
	}
	return ' ' + parts.join(' ');
}

function attrPair(name: string, value: string, placeholder: boolean, state: TabState): string {
	if (placeholder) {
		return `${name}="${tab(state)}"`;
	}
	return `${name}="${escapeAttr(value)}"`;
}

function renderBoilerplate(level: number, ctx: Ctx, state: TabState): string {
	const lang = escapeAttr(ctx.variables.lang || 'en');
	const charset = escapeAttr(ctx.variables.charset || 'UTF-8');
	const nl1 = newline(level + 1, ctx);
	const nl2 = newline(level + 2, ctx);
	return (
		'<!DOCTYPE html>' +
		newline(level, ctx) +
		`<html lang="${lang}">` +
		nl1 +
		'<head>' +
		nl2 +
		`<meta charset="${charset}">` +
		nl2 +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
		nl2 +
		`<title>${tab(state, 'Document')}</title>` +
		nl1 +
		'</head>' +
		nl1 +
		'<body>' +
		nl2 +
		tab(state) +
		nl1 +
		'</body>' +
		newline(level, ctx) +
		'</html>'
	);
}

function newline(level: number, ctx: Ctx): string {
	return '\n' + ctx.indent.repeat(level);
}

function loremText(name: string): string {
	const match = /^lorem(\d+)?$/i.exec(name);
	const count = match?.[1] ? parseInt(match[1], 10) : 30;
	const words: string[] = [];
	for (let i = 0; i < count; i++) {
		words.push(LOREM_WORDS[i % LOREM_WORDS.length]);
	}
	if (words.length > 0) {
		words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
	}
	return words.join(' ');
}

function applyNumbering(text: string, numbering: Num): string {
	return text.replace(/\$+(@(-)?(\d+)?)?/g, match => {
		const dollars = /^\$+/.exec(match)?.[0].length ?? 1;
		const descending = match.indexOf('@-') !== -1;
		const startMatch = /@-?(\d+)/.exec(match);
		const start = startMatch ? parseInt(startMatch[1], 10) : undefined;
		let value: number;
		if (descending) {
			const base = start ?? numbering.count;
			value = base - numbering.index;
		} else if (start !== undefined) {
			value = start + numbering.index;
		} else {
			value = numbering.index + 1;
		}
		const printed = String(value);
		if (dollars > 1 && printed.length < dollars) {
			return printed.padStart(dollars, '0');
		}
		return printed;
	});
}

function tab(state: TabState, fallback?: string): string {
	const id = state.next++;
	state.defaults[id] = fallback ?? '';
	return `\u0000${id}\u0000`;
}

function finalizeTabs(raw: string, state: TabState): string {
	const ids: number[] = [];
	const re = /\u0000(\d+)\u0000/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(raw))) {
		const id = parseInt(match[1], 10);
		if (ids.indexOf(id) === -1) {
			ids.push(id);
		}
	}
	if (ids.length === 0) {
		return raw;
	}
	const last = ids[ids.length - 1];
	const numbers = new Map<number, number>();
	let next = 1;
	for (const id of ids) {
		numbers.set(id, id === last ? 0 : next++);
	}
	return raw.replace(/\u0000(\d+)\u0000/g, (_full, digits: string) => {
		const id = parseInt(digits, 10);
		const num = numbers.get(id) ?? 0;
		const fallback = state.defaults[id] ?? '';
		if (fallback) {
			return '${' + num + ':' + fallback.replace(/\}/g, '\\}') + '}';
		}
		return num === 0 ? '$0' : '$' + num;
	});
}

function applyBaseIndent(snippet: string, baseIndent: string): string {
	if (!baseIndent) {
		return snippet;
	}
	const lines = snippet.split('\n');
	return lines.map((line, index) => (index === 0 || line.length === 0 ? line : baseIndent + line)).join('\n');
}

function escapeText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function escapeAttr(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// --- css -------------------------------------------------------------------

function expandCss(input: string, options: ExpandOptions): string | undefined {
	if (input.indexOf('+') === -1 && CSS_RAW[input] !== undefined) {
		return applyBaseIndent(CSS_RAW[input], options.baseIndent ?? '');
	}
	const parts = input.split('+');
	if (parts.length === 0 || parts.some(part => part.length === 0)) {
		return undefined;
	}
	const state: TabState = { next: 0, defaults: [] };
	const lines: string[] = [];
	for (const part of parts) {
		const decl = resolveCssDeclaration(part, options.tabTrigger === true, state);
		if (!decl) {
			return undefined;
		}
		lines.push(decl);
	}
	return applyBaseIndent(finalizeTabs(lines.join('\n'), state), options.baseIndent ?? '');
}

function resolveCssDeclaration(token: string, tabTrigger: boolean, state: TabState): string | undefined {
	let important = false;
	let body = token;
	if (body.endsWith('!')) {
		important = true;
		body = body.slice(0, -1);
	}
	if (!body) {
		return undefined;
	}
	for (const key of CSS_KEYS) {
		if (!body.startsWith(key)) {
			continue;
		}
		const rest = body.slice(key.length);
		const spec = CSS_PROPS[key];
		if (rest === '') {
			if (tabTrigger && key.length === 1 && spec.value === undefined) {
				return undefined;
			}
			const value = spec.value ?? tab(state);
			return formatDecl(spec.prop, value, important);
		}
		if (spec.value !== undefined) {
			continue;
		}
		const parsed = parseCssValue(rest);
		if (parsed === undefined) {
			continue;
		}
		return formatDecl(spec.prop, parsed, important);
	}
	return undefined;
}

function formatDecl(prop: string, value: string, important: boolean): string {
	return important ? `${prop}: ${value} !important;` : `${prop}: ${value};`;
}

function parseCssValue(rest: string): string | undefined {
	if (/^#[0-9a-fA-F]{3,8}$/.test(rest)) {
		return rest;
	}
	if (/^[a-z][a-z-]*$/i.test(rest)) {
		return rest;
	}
	const parts: string[] = [];
	let i = 0;
	while (i < rest.length) {
		let sign = '';
		if (rest.charAt(i) === '-' && /[0-9.]/.test(rest.charAt(i + 1))) {
			sign = '-';
			i++;
		}
		const num = /^(\d*\.?\d+)/.exec(rest.slice(i));
		if (!num || num[0] === '' || num[0] === '.') {
			return undefined;
		}
		i += num[0].length;
		let unit = 'px';
		const unitMatch = /^[a-z%]+/i.exec(rest.slice(i));
		if (unitMatch) {
			unit = mapCssUnit(unitMatch[0]);
			i += unitMatch[0].length;
		}
		parts.push(sign + num[0] + unit);
		if (i >= rest.length) {
			break;
		}
		if (rest.charAt(i) !== '-') {
			return undefined;
		}
		i++;
	}
	if (parts.length === 0) {
		return undefined;
	}
	return parts.join(' ');
}

function mapCssUnit(unit: string): string {
	switch (unit) {
		case 'p':
			return '%';
		case 'e':
			return 'em';
		case 'r':
			return 'rem';
		case 'x':
			return 'ex';
		default:
			return unit;
	}
}

// --- balance scanner -------------------------------------------------------

interface TagNode {
	name: string;
	outerStart: number;
	outerEnd: number;
	innerStart: number;
	innerEnd: number;
	children: TagNode[];
}

function parseMarkupTree(source: string): TagNode[] {
	const root: TagNode = {
		name: '',
		outerStart: 0,
		outerEnd: source.length,
		innerStart: 0,
		innerEnd: source.length,
		children: []
	};
	const stack: TagNode[] = [root];
	let i = 0;
	while (i < source.length) {
		if (source.startsWith('<!--', i)) {
			const end = source.indexOf('-->', i + 4);
			i = end === -1 ? source.length : end + 3;
			continue;
		}
		if (source.charAt(i) !== '<') {
			i++;
			continue;
		}
		if (source.charAt(i + 1) === '/') {
			const close = /^<\/([A-Za-z][\w:.-]*)\s*>/.exec(source.slice(i));
			if (!close) {
				i++;
				continue;
			}
			const name = close[1].toLowerCase();
			const closeEnd = i + close[0].length;
			for (let s = stack.length - 1; s >= 1; s--) {
				if (stack[s].name === name) {
					stack[s].innerEnd = i;
					stack[s].outerEnd = closeEnd;
					stack.length = s;
					break;
				}
			}
			i = closeEnd;
			continue;
		}
		const open = /^<([A-Za-z][\w:.-]*)/.exec(source.slice(i));
		if (!open) {
			i++;
			continue;
		}
		let j = i + open[0].length;
		let quote: string | undefined;
		let selfClosing = false;
		while (j < source.length) {
			const ch = source.charAt(j);
			if (quote) {
				if (ch === quote) {
					quote = undefined;
				}
				j++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				j++;
				continue;
			}
			if (ch === '/' && source.charAt(j + 1) === '>') {
				selfClosing = true;
				j += 2;
				break;
			}
			if (ch === '>') {
				j++;
				break;
			}
			j++;
		}
		const name = open[1].toLowerCase();
		const node: TagNode = {
			name,
			outerStart: i,
			outerEnd: j,
			innerStart: j,
			innerEnd: j,
			children: []
		};
		stack[stack.length - 1].children.push(node);
		if (!selfClosing && !VOID_TAGS.has(name)) {
			stack.push(node);
		}
		i = j;
	}
	for (let s = 1; s < stack.length; s++) {
		stack[s].outerEnd = source.length;
		stack[s].innerEnd = source.length;
	}
	return root.children;
}

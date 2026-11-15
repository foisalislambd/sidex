import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	abbreviationBeforeCursor,
	balanceMarkup,
	expandAbbreviation,
	syntaxForLanguage,
	type ExpandOptions
} from '../../src/vs/workbench/contrib/emmet/common/expand.ts';

const html: ExpandOptions = { syntax: 'html', indent: '\t' };
const jsx: ExpandOptions = { syntax: 'jsx', indent: '\t' };
const css: ExpandOptions = { syntax: 'css', indent: '\t' };

function expand(input: string, options: ExpandOptions = html): string {
	const result = expandAbbreviation(input, options);
	assert.ok(result !== undefined, `expected ${input} to expand`);
	return result;
}

test('expands a plain tag with a cursor stop', () => {
	assert.equal(expand('div'), '<div>$0</div>');
});

test('nests children on their own lines', () => {
	assert.equal(expand('div>p'), '<div>\n\t<p>$0</p>\n</div>');
});

test('expands class and id shortcuts', () => {
	assert.equal(expand('.row'), '<div class="row">$0</div>');
	assert.equal(expand('div#app.a.b'), '<div id="app" class="a b">$0</div>');
});

test('repeats and numbers classes', () => {
	assert.equal(
		expand('ul>li.item$*3'),
		'<ul>\n\t<li class="item1">$1</li>\n\t<li class="item2">$2</li>\n\t<li class="item3">$0</li>\n</ul>'
	);
});

test('numbers with an explicit start and descending order', () => {
	assert.equal(
		expand('ul>li.item$@3*3'),
		'<ul>\n\t<li class="item3">$1</li>\n\t<li class="item4">$2</li>\n\t<li class="item5">$0</li>\n</ul>'
	);
	assert.equal(
		expand('ul>li.item$@-*3'),
		'<ul>\n\t<li class="item3">$1</li>\n\t<li class="item2">$2</li>\n\t<li class="item1">$0</li>\n</ul>'
	);
	assert.equal(expand('div.item$$'), '<div class="item01">$0</div>');
});

test('expands the anchor alias with href and text stops', () => {
	assert.equal(expand('a'), '<a href="$1">$0</a>');
	assert.equal(expand('a.btn'), '<a href="$1" class="btn">$0</a>');
	assert.equal(expand('btn'), '<button>$0</button>');
});

test('places siblings and climb operators', () => {
	assert.equal(expand('div+p'), '<div>$1</div>\n<p>$0</p>');
	assert.equal(expand('div>ul>li^p'), '<div>\n\t<ul>\n\t\t<li>$1</li>\n\t</ul>\n\t<p>$0</p>\n</div>');
	assert.equal(expand('div>ul>li^^p'), '<div>\n\t<ul>\n\t\t<li>$1</li>\n\t</ul>\n</div>\n<p>$0</p>');
});

test('expands groups', () => {
	assert.equal(
		expand('(header>ul>li*2)+footer'),
		'<header>\n\t<ul>\n\t\t<li>$1</li>\n\t\t<li>$2</li>\n\t</ul>\n</header>\n<footer>$0</footer>'
	);
	assert.equal(expand('(div.item$)*2'), '<div class="item1">$1</div>\n<div class="item2">$0</div>');
});

test('keeps inline parents on one line and block parents multiline', () => {
	assert.equal(expand('span>em'), '<span><em>$0</em></span>');
	assert.equal(expand('div>span+em'), '<div>\n\t<span>$1</span>\n\t<em>$0</em>\n</div>');
	assert.equal(expand('div{Hello}'), '<div>Hello</div>');
	assert.equal(expand('div>{Click }+a{here}'), '<div>\n\tClick <a href="$0">here</a>\n</div>');
});

test('expands void tags, boolean attributes, and aliases', () => {
	assert.equal(expand('img'), '<img src="$1" alt="$0">');
	assert.equal(expand('input[type=checkbox checked]'), '<input type="checkbox" checked>');
	assert.equal(expand('input:email'), '<input type="email">');
	assert.equal(expand('link:css'), '<link rel="stylesheet" href="$0">');
	assert.equal(
		expand('meta:vp'),
		'<meta name="viewport" content="width=device-width, initial-scale=1.0">'
	);
});

test('escapes text and attribute values', () => {
	assert.equal(expand('div{a<b&c}'), '<div>a&lt;b&amp;c</div>');
	assert.equal(expand('div[title="say \\"hi\\""]'), '<div title="say &quot;hi&quot;">$0</div>');
});

test('uses implicit tag names from the parent', () => {
	assert.equal(expand('ul>.item'), '<ul>\n\t<li class="item">$0</li>\n</ul>');
	assert.equal(expand('em>.note'), '<em><span class="note">$0</span></em>');
	assert.equal(expand('table>.row>.cell'), '<table>\n\t<tr class="row">\n\t\t<td class="cell">$0</td>\n\t</tr>\n</table>');
});

test('expands html boilerplate and lorem', () => {
	const doc = expand('!', { ...html, variables: { lang: 'fr', charset: 'ISO-8859-1' } });
	assert.ok(doc.startsWith('<!DOCTYPE html>\n<html lang="fr">'));
	assert.ok(doc.includes('<meta charset="ISO-8859-1">'));
	assert.ok(doc.includes('<title>${1:Document}</title>'));
	assert.ok(doc.includes('<body>\n\t\t$0\n\t</body>'));
	assert.equal(expand('html:5').startsWith('<!DOCTYPE html>'), true);
	assert.equal(expand('lorem5'), 'Lorem ipsum dolor sit amet');
	assert.equal(expand('p>lorem3'), '<p>Lorem ipsum dolor</p>');
});

test('formats jsx with className and self-closing tags', () => {
	assert.equal(expand('div.a', jsx), '<div className="a">$0</div>');
	assert.equal(expand('img', jsx), '<img src="$1" alt="$0" />');
	assert.equal(expand('input[type=checkbox checked]', jsx), '<input type="checkbox" checked={true} />');
});

test('rejects unknown bare words and accepts custom elements', () => {
	assert.equal(expandAbbreviation('foo', html), undefined);
	assert.equal(expandAbbreviation('foodiv', html), undefined);
	assert.equal(expand('foo-bar'), '<foo-bar>$0</foo-bar>');
	assert.equal(expand('ul>foo'), '<ul>\n\t<foo>$0</foo>\n</ul>');
});

test('prefixes continuation lines with the base indent', () => {
	assert.equal(expandAbbreviation('div>p', { ...html, baseIndent: '\t\t' }), '<div>\n\t\t\t<p>$0</p>\n\t\t</div>');
});

test('wraps a selection, repeating a bare multiplier once per line', () => {
	assert.equal(expandAbbreviation('div', { ...html, wrapText: 'hello' }), '<div>hello</div>');
	assert.equal(
		expandAbbreviation('div', { ...html, wrapText: 'one\ntwo' }),
		'<div>\n\tone\n\ttwo\n</div>'
	);
	assert.equal(
		expandAbbreviation('ul>li*', { ...html, wrapText: 'One\nTwo' }),
		'<ul>\n\t<li>One</li>\n\t<li>Two</li>\n</ul>'
	);
	assert.equal(
		expandAbbreviation('ul>li.item$*', { ...html, wrapText: 'A\nB' }),
		'<ul>\n\t<li class="item1">A</li>\n\t<li class="item2">B</li>\n</ul>'
	);
});

test('expands css properties, units, colors, and !important', () => {
	assert.equal(expand('m10', css), 'margin: 10px;');
	assert.equal(expand('db+p10', css), 'display: block;\npadding: 10px;');
	assert.equal(expand('w100p', css), 'width: 100%;');
	assert.equal(expand('m-10--20', css), 'margin: -10px -20px;');
	assert.equal(expand('posa', css), 'position: absolute;');
	assert.equal(expand('m10!', css), 'margin: 10px !important;');
	assert.equal(expand('c#f00', css), 'color: #f00;');
	assert.equal(expand('fz14r', css), 'font-size: 14rem;');
	assert.equal(expand('p', css), 'padding: $0;');
	assert.equal(expandAbbreviation('p', { ...css, tabTrigger: true }), undefined);
	assert.equal(expandAbbreviation('p10', { ...css, tabTrigger: true }), 'padding: 10px;');
	assert.equal(expandAbbreviation('db', { ...css, tabTrigger: true }), 'display: block;');
	assert.ok(expand('cf', css).includes('clear: both;'));
});

test('finds the abbreviation that ends at the cursor', () => {
	assert.deepEqual(abbreviationBeforeCursor('  div', 5, html), { abbreviation: 'div', start: 2 });
	assert.equal(abbreviationBeforeCursor('foodiv', 6, html), undefined);
	assert.deepEqual(abbreviationBeforeCursor('x div>p', 7, html), { abbreviation: 'div>p', start: 2 });
	assert.deepEqual(abbreviationBeforeCursor('.row', 4, html), { abbreviation: '.row', start: 0 });
	assert.equal(abbreviationBeforeCursor('const div', 9, { ...html, syntax: 'html' })?.abbreviation, 'div');
});

test('balances outward and inward through nested tags', () => {
	const source = '<div><p>Hi</p></div>';
	const hi = source.indexOf('Hi');
	const p = balanceMarkup(source, hi, hi + 2, 'out');
	assert.deepEqual(p, { start: source.indexOf('<p>'), end: source.indexOf('</p>') + 4 });
	const div = balanceMarkup(source, p!.start, p!.end, 'out');
	assert.deepEqual(div, { start: 0, end: source.length });
	assert.equal(balanceMarkup(source, 0, source.length, 'out'), undefined);
	const inside = balanceMarkup(source, p!.start, p!.end, 'in');
	assert.deepEqual(inside, { start: source.indexOf('Hi'), end: source.indexOf('Hi') + 2 });
});

test('ignores angle brackets inside attribute quotes when balancing', () => {
	const source = '<div title="a>b"><span>x</span></div>';
	const x = source.indexOf('x');
	const span = balanceMarkup(source, x, x + 1, 'out');
	assert.equal(source.slice(span!.start, span!.end), '<span>x</span>');
});

test('maps language ids through include and exclude lists', () => {
	assert.equal(syntaxForLanguage('html'), 'html');
	assert.equal(syntaxForLanguage('typescriptreact'), 'jsx');
	assert.equal(syntaxForLanguage('scss'), 'css');
	assert.equal(syntaxForLanguage('javascript', { javascript: 'javascriptreact' }), 'jsx');
	assert.equal(syntaxForLanguage('html', undefined, ['html']), undefined);
	assert.equal(syntaxForLanguage('plaintext'), undefined);
	assert.equal(syntaxForLanguage('markdown'), undefined);
	assert.equal(syntaxForLanguage('markdown', { markdown: 'html' }), 'html');
});

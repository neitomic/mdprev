use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;

use comrak::adapters::{CodefenceRendererAdapter, SyntaxHighlighterAdapter};
use comrak::nodes::Sourcepos;
use comrak::options::Plugins;
use comrak::{markdown_to_html_with_plugins, Options};
use syntect::html::{css_for_theme_with_class_style, ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

const CLASS_STYLE: ClassStyle = ClassStyle::Spaced;

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

struct MermaidRenderer;

impl CodefenceRendererAdapter for MermaidRenderer {
    fn write(
        &self,
        output: &mut dyn fmt::Write,
        _lang: &str,
        _meta: &str,
        code: &str,
        _sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        write!(output, "<pre class=\"mermaid\">{}</pre>", escape_html(code))
    }
}

struct BobRenderer;

impl CodefenceRendererAdapter for BobRenderer {
    fn write(
        &self,
        output: &mut dyn fmt::Write,
        _lang: &str,
        _meta: &str,
        code: &str,
        _sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        write!(output, "<div class=\"svgbob\">{}</div>", svgbob::to_svg(code))
    }
}

struct SyntectHighlighter<'s> {
    syntax_set: &'s SyntaxSet,
}

impl SyntaxHighlighterAdapter for SyntectHighlighter<'_> {
    fn write_highlighted(
        &self,
        output: &mut dyn fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> fmt::Result {
        let syntax = lang
            .filter(|l| !l.is_empty())
            .and_then(|l| self.syntax_set.find_syntax_by_token(l));
        let Some(syntax) = syntax else {
            return output.write_str(&escape_html(code));
        };
        let mut generator =
            ClassedHTMLGenerator::new_with_class_style(syntax, self.syntax_set, CLASS_STYLE);
        for line in LinesWithEndings::from(code) {
            if generator
                .parse_html_for_line_which_includes_newline(line)
                .is_err()
            {
                return output.write_str(&escape_html(code));
            }
        }
        output.write_str(&generator.finalize())
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn fmt::Write,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> fmt::Result {
        write_tag(output, "pre", attributes)
    }

    fn write_code_tag(
        &self,
        output: &mut dyn fmt::Write,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> fmt::Result {
        write_tag(output, "code", attributes)
    }
}

fn write_tag(
    output: &mut dyn fmt::Write,
    tag: &str,
    attributes: HashMap<&'static str, Cow<'_, str>>,
) -> fmt::Result {
    write!(output, "<{tag}")?;
    for (name, value) in attributes {
        write!(output, " {name}=\"{}\"", escape_html(&value))?;
    }
    write!(output, ">")
}

pub struct Renderer {
    syntax_set: SyntaxSet,
    pub syntax_css: String,
}

impl Renderer {
    pub fn new() -> Self {
        let syntax_set = SyntaxSet::load_defaults_newlines();
        let themes = syntect::highlighting::ThemeSet::load_defaults();
        let light = css_for_theme_with_class_style(&themes.themes["InspiredGitHub"], CLASS_STYLE)
            .unwrap_or_default();
        let dark = css_for_theme_with_class_style(&themes.themes["base16-ocean.dark"], CLASS_STYLE)
            .unwrap_or_default();
        let syntax_css =
            format!("{light}\n@media (prefers-color-scheme: dark) {{\n{dark}\n}}\n");
        Self { syntax_set, syntax_css }
    }

    pub fn render(&self, markdown: &str) -> String {
        let mut options = Options::default();
        options.extension.table = true;
        options.extension.strikethrough = true;
        options.extension.tasklist = true;
        options.extension.autolink = true;
        options.extension.footnotes = true;
        options.extension.alerts = true;
        options.extension.header_id_prefix = Some(String::new());
        options.extension.front_matter_delimiter = Some("---".to_string());
        options.render.r#unsafe = true;

        let mermaid = MermaidRenderer;
        let bob = BobRenderer;
        let highlighter = SyntectHighlighter { syntax_set: &self.syntax_set };

        let mut plugins = Plugins::default();
        for lang in ["mermaid"] {
            plugins.render.codefence_renderers.insert(lang.to_string(), &mermaid);
        }
        for lang in ["bob", "svgbob", "ascii"] {
            plugins.render.codefence_renderers.insert(lang.to_string(), &bob);
        }
        plugins.render.codefence_syntax_highlighter = Some(&highlighter);

        markdown_to_html_with_plugins(markdown, &options, &plugins)
    }
}

/// Wrap rendered body HTML in the full page layout.
///
/// `watch_path` is the root-relative path the live-reload client subscribes
/// to; `kind` is "file" or "dir" (dir pages fully reload on any change).
pub fn page(title: &str, breadcrumbs: &str, body: &str, watch_path: &str, kind: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="/__assets/app.css">
<link rel="stylesheet" href="/__assets/syntax.css">
<script src="/__assets/app.js" defer></script>
</head>
<body data-path="{path}" data-kind="{kind}">
<nav class="crumbs">{breadcrumbs}</nav>
<main class="markdown-body">
{body}
</main>
</body>
</html>
"#,
        title = escape_html(title),
        path = escape_html(watch_path),
    )
}

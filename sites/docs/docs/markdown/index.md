---
title: Markdown Reference
sidebar_position: 1
---

Evidence supports most markdown syntax. Below are some of the most common markdown features. For more details, check out [Markdown Guide](https://www.markdownguide.org/cheat-sheet/).

## Text Paragraphs

```markdown
This is a paragraph. It can be as long as you want. 

Add line breaks by leaving a blank line between paragraphs.
```

## Text Styles

```markdown
**Bold** text is wrapped in double asterisks
*Italic* text is wrapped in single asterisks
~~Strikethrough~~ text is wrapped in double tildes
`Inline code` is wrapped in backticks
```

## Lists

```markdown
- This is a unordered list
- It uses dashes
- To indicate items

1. This is an ordered list
1. It uses numbers to indicate order
1. The numbers you type don't matter, they will be automatically numbered
```

## Headers

```markdown
# H1 Header

## H2 Header

### H3 Header

#### H4 Header

##### H5 Header

###### H6 Header
```


## Links

```markdown
[External link](https://google.com)

[Internal link](another/page/)
```

## Images

```
![An online image](https://i.imgur.com/xyI27iZ.gif)

![An image stored in the project](my-image.png)
```

#### Storing Images and Static Files

Evidence looks for images in the `/static` folder in the root of your project. Create it if it doesn't exist.

```
+-- pages/
|   `-- index.md
`-- static/
    `-- my-image.png
```

## Code Fences

In Evidence, most code fences execute SQL queries and display the results in a table.


 
````markdown
This code fence will execute a SQL query and display the results:

```widget_orders 
SELECT * 
FROM orders 
WHERE category = 'widget'
```
````

The exception is if you use one of the [reserved language names](https://github.com/evidence-dev/evidence/blob/main/packages/preprocess/supportedLanguages.cjs), which will render the code in a code block.

````markdown
```python
names = ["Alice", "Bob", "Charlie"]

for name in names:
    print("Hello, " + name)
```

```r
names <- c("Alice", "Bob", "Charlie")

for (name in names) {
    print(paste("Hello, ", name))
}
```
````

## Tables

```markdown
| Column 1 | Column 2 | Column 3 |
| -------- | -------- | -------- |
| Row 1    | Row 1    | Row 1    |
| Row 2    | Row 2    | Row 2    |
```

To display data in a table, use a [Data Table](../components/data-table) instead.

## Blockquotes

```markdown
> This is a blockquote
>
> It can span multiple lines
> > And can be nested
```

## Frontmatter

To attach metadata (e.g. a title) to your page, use Frontmatter.

Frontmatter is formatted like this:
```markdown
---
title: Evidence Docs
---
```

You can put whatever data you would like here, and it uses a [yaml syntax](https://yaml.org/), but some properties are special:

| Property         | Effect                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `title`          | changes the name of the tab, and also adds a header to your page                                                             |
| `description`    | is used for search engines                                                                                                   |
| `og`             | changes how your link shows up when shared on things like Slack, Facebook, Twitter, Discord, etc                             |
| `og.title`       | changes the title that appears in the embed; if this is not specified, but `title` is, then `title` is used (and vise versa) |
| `og.description` | changes the body of the embed                                                                                                |
| `og.image`       | will appear in the embed if specified, but it is not required.                                                               |

Anything outside of these values won't do anything on their own, but they will be accessible as [variables](/core-concepts/syntax/#expressions) on the page.
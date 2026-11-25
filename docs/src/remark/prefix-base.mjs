// The site lives under a folder of the Pages address, so a link written as /guides/upgrading/ has to
// become /eigenwise-toolshed/guides/upgrading/. Starlight does this for its own sidebar and hero, but
// not for links inside page text, so pages and the generated reference are written without the folder.
const isSiteLink = (value, base) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && value !== base && !value.startsWith(`${base}/`);

const withBase = (value, base) => (isSiteLink(value, base) ? `${base}${value}` : value);

const prefixHtml = (html, base) => html.replace(/(href=")(\/(?!\/)[^"]*)"/g, (_whole, start, path) => `${start}${withBase(path, base)}"`);

const prefixNode = (node, base) => {
  if (node.type === 'link' || node.type === 'definition') node.url = withBase(node.url, base);
  if (node.type === 'html') node.value = prefixHtml(node.value, base);
  if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
    for (const attribute of node.attributes ?? []) {
      if (attribute.type === 'mdxJsxAttribute' && attribute.name === 'href') attribute.value = withBase(attribute.value, base);
    }
  }
  for (const child of node.children ?? []) prefixNode(child, base);
};

export default function remarkPrefixBase({ base }) {
  return (tree) => prefixNode(tree, base.replace(/\/$/, ''));
}

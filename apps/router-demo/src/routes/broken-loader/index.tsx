// broken-loader leaf。layout loader が throw するので leaf も mount されない想定。
export default function BrokenLoaderPage() {
  return <p data-testid="broken-loader-leaf">broken-loader leaf (should NOT be rendered)</p>;
}

// broken-render leaf。layout の render が throw するので leaf も mount されない想定。
export default function BrokenRenderPage() {
  return <p data-testid="broken-render-leaf">broken-render leaf (should NOT be rendered)</p>;
}

// 全 route に被せる global layout。app.ts で `.use("*", hibanaLayout(AppLayout))` で
// chain に組み込む。nested layout dogfood の親側 (= 子の PostsLayout を内側に包む)。

export function AppLayout({ children }: { children: Node }) {
  return (
    <>
      <header style="background: #222; color: white; padding: 12px 24px;">
        <a href="/" style="color: white; text-decoration: none; font-weight: bold;">
          Hibana Demo
        </a>
      </header>
      <div data-testid="app-layout-content">{children}</div>
      <footer style="background: #f5f5f5; padding: 12px 24px; margin-top: 32px;">
        <small>nested layout dogfood (= Step 4 (3))</small>
      </footer>
    </>
  );
}

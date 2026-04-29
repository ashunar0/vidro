import { signal } from "@vidro/core";

function App() {
  const count = signal(0);

  return (
    <div>
      <h1>Hello, Vidro!</h1>
      <h3>{count.value}</h3>
      <button type="button" onClick={() => count.value++}>
        add
      </button>
    </div>
  );
}

export default App;

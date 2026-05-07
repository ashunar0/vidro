import { createSignal } from "solid-js";

function App() {
  const [count, setCount] = createSignal(0);

  return (
    <div>
      <h1>Bench Counter</h1>
      <h3>{count()}</h3>
      <button type="button" onClick={() => setCount(count() + 1)}>
        add
      </button>
    </div>
  );
}

export default App;

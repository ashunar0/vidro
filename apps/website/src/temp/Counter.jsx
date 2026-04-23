import { Signal } from "@vidro/core";

export function Counter() {
  const count = new Signal(0);

  return (
    <div>
      <h1>Counter</h1>
      <p>{count.value}</p>
      <button onClick={() => count.value++}>Increment</button>
      <button onClick={() => count.value--}>Decrement</button>
    </div>
  );
}

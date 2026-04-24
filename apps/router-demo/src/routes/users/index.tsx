import { Link } from "@vidro/router";

export default function Users() {
  return (
    <section>
      <h2>Users</h2>
      <p>Pick a user:</p>
      <ul>
        <li>
          <Link href="/users/1">User 1</Link>
        </li>
        <li>
          <Link href="/users/42">User 42</Link>
        </li>
      </ul>
    </section>
  );
}

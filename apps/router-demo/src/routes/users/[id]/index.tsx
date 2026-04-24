type Props = {
  params: { id: string };
};

export default function UserPage(props: Props) {
  return (
    <section>
      <h2>User</h2>
      <p>
        User ID: <strong>{props.params.id}</strong>
      </p>
      <p>
        (dynamic segment <code>/users/[id]</code> にマッチしているのだ)
      </p>
    </section>
  );
}

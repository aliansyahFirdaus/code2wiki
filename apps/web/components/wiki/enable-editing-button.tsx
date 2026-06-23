export function EnableEditingButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      Enable Editing
    </button>
  );
}

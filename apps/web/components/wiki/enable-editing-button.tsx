import styles from "./wiki-reader.module.css";

export function EnableEditingButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={styles.button}>
      Edit
    </button>
  );
}

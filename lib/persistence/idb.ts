/**
 * Minimal IndexedDB helpers with ordered, append-only schema migrations.
 *
 * The database version is the number of migrations. Opening runs every migration
 * the stored database hasn't seen yet, in order, inside the upgrade transaction —
 * so a browser on any older version is brought forward step by step without data loss.
 * To change the schema: append a migration. Never edit or reorder existing ones.
 */
export type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

export function openDatabase(name: string, migrations: readonly Migration[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, migrations.length);
    request.onupgradeneeded = (event) => {
      const tx = request.transaction;
      if (!tx) return;
      for (let version = event.oldVersion; version < migrations.length; version++) migrations[version](request.result, tx);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer tab upgrade the schema instead of being blocked by this connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`${name}: upgrade blocked by another open connection`));
  });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

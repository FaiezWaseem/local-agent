declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string);
    exec(sql: string): unknown;
    prepare(sql: string): {
      run(...params: any[]): unknown;
      all(...params: any[]): unknown[];
    };
  }
}

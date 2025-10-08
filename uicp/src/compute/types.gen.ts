// Generated stubs mirroring WIT task IO for typed hosts/guests.
// csv.parse@1.2.0
export type CsvParseInput = {
  source: string;
  hasHeader: boolean;
};
export type CsvParseOutput = string[][];

// table.query@0.1.0
export type TableQueryInput = {
  rows: string[][];
  select: number[];
  whereContains?: { col: number; needle: string } | null;
};
export type TableQueryOutput = string[][];

export type KnownTaskIO =
  | { task: `csv.parse@${string}`; input: CsvParseInput; output: CsvParseOutput }
  | { task: `table.query@${string}`; input: TableQueryInput; output: TableQueryOutput };


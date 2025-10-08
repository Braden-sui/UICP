// Generated from WIT files. Do not edit by hand.
export type CsvParseInput = { source: string; hasHeader: boolean };
export type CsvParseOutput = string[][];
export type TableQueryInput = { rows: string[][]; select: number[]; whereContains: { col: number; needle: string } | null };
export type TableQueryOutput = string[][];

export type KnownTaskIO =
  | { task: `csv.parse@${string}`; input: CsvParseInput; output: CsvParseOutput }
  | { task: `table.query@${string}`; input: TableQueryInput; output: TableQueryOutput };

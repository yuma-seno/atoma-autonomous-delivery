/**
 * Types for `@huggingface/transformers`, declared rather than depended on.
 *
 * The package is not a build-time dependency and deliberately is not one: it is
 * excluded from the bundle (see build-dist.ts) and installed on the runner from
 * `mcp-packages.json`, because it reaches onnxruntime's native binaries and a
 * JavaScript bundler cannot carry those. Adding it to `package.json` would put a
 * 600MB install into every CI run to type-check two function signatures.
 *
 * So the shape is written here instead, covering only what `mcp/search.ts` uses.
 * If that file starts using more of the library, this grows with it — and if the
 * two ever disagree, the failure shows up at the first tool call rather than at
 * compile time. That is the trade being made, and it is the same trade the
 * bundle exclusion already forced.
 */
declare module "@huggingface/transformers" {
  /** A tensor as this code consumes it: logits, read as plain numbers. */
  export interface Tensor {
    tolist(): number[][];
  }

  export interface TokenizerOptions {
    text_pair?: string[];
    padding?: boolean;
    truncation?: boolean;
    max_length?: number;
  }

  export type Tokenizer = (texts: string[], options?: TokenizerOptions) => Record<string, unknown>;

  export interface PretrainedOptions {
    /** Quantisation of the ONNX weights to load, e.g. "q8" or "fp32". */
    dtype?: string;
    /** Subdirectory holding the ONNX files, for repositories that keep them at the root. */
    subfolder?: string;
  }

  export const AutoTokenizer: {
    from_pretrained(model: string, options?: PretrainedOptions): Promise<Tokenizer>;
  };

  export const AutoModelForSequenceClassification: {
    from_pretrained(
      model: string,
      options?: PretrainedOptions,
    ): Promise<(inputs: Record<string, unknown>) => Promise<{ logits: Tensor }>>;
  };
}

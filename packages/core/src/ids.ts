export type IdGenerator = (prefix: string) => string;

/** Random ids such as `n_3fa91c02b7de`. Callers must still check for collisions. */
export const randomIds: IdGenerator = (prefix) =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

/** Predictable ids (`n_1`, `n_2`, `e_1`...) for tests, samples and golden files. */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

/** Ids appear in file names and generated code, so keep them boring and portable. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

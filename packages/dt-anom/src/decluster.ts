export interface DeclusterOptions {
  readonly minSeparation: number;
}

export interface ClusteredPoint<T> {
  readonly index: number;
  readonly value: number;
  readonly payload: T;
}

export function declusterExceedances<T>(points: readonly ClusteredPoint<T>[], options: DeclusterOptions): ClusteredPoint<T>[] {
  if (points.length === 0) {
    return [];
  }
  const result: ClusteredPoint<T>[] = [];
  let lastIndex = -Infinity;
  for (const point of points) {
    if (point.index - lastIndex > options.minSeparation) {
      result.push(point);
      lastIndex = point.index;
    }
  }
  return result;
}

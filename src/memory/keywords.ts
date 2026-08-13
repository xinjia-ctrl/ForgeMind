const TOKEN = /[\p{L}\p{N}_./-]+/gu;

export function keywords(value: string): readonly string[] {
  return [
    ...new Set(
      (value.toLocaleLowerCase().match(TOKEN) ?? [])
        .map((token) => token.replace(/^[-./]+|[-./]+$/g, ""))
        .filter((token) => token.length > 1),
    ),
  ];
}

export function keywordOverlap(left: string, right: string): readonly string[] {
  const rightTerms = new Set(keywords(right));
  return keywords(left).filter((term) => rightTerms.has(term));
}

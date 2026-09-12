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

import type { R2Bucket } from "@cloudflare/workers-types";

import type { R2Key } from "../types.ts";

export const headObject = async (r2: R2Bucket, key: R2Key): Promise<boolean> =>
  (await r2.head(key)) !== null;

export const putText = async (r2: R2Bucket, key: R2Key, text: string): Promise<void> => {
  await r2.put(key, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
};

export const putBinary = async (r2: R2Bucket, key: R2Key, data: ArrayBuffer): Promise<void> => {
  await r2.put(key, data, {
    httpMetadata: { contentType: "application/pdf" },
  });
};

// `as R2Key` is the branded-type constructor: R2Key is `string & Brand<"R2Key">`,
// so there is no way to construct a value of this type without a cast.
// This is the standard pattern for Effect Schema branded types.
export const makeR2Key = (
  court: string,
  year: number,
  num: string,
  title: string,
  ext: "txt" | "pdf",
): R2Key => `${court}/${year}/${num} - ${title}.${ext}` as R2Key;

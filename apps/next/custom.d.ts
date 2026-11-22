declare module "*.css" {}

declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_SCARN_API_URL?: string;
  }
}

declare module "*.svg" {
  const content: import("next/image").StaticImageData;
  export default content;
}

import { S3Adapter } from './s3-adapter.js'

/** Shared S3Adapter instance — stateless, safe to share across routes. */
export const s3Adapter = new S3Adapter()

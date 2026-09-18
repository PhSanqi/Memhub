export interface CloudflareIdentity {
    sub: string;
    email: string;
}
export declare function verifyCloudflareAccessJwt(rootDir: string, publicHost: string, token: string): Promise<CloudflareIdentity>;

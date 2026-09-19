export declare function hasAccounts(rootDir: string): Promise<boolean>;
export declare function listAccounts(rootDir: string): Promise<{
    username: string;
    account_id: string;
    created_at: string;
    cloudflare_email?: string;
}[]>;
export declare function addAccount(rootDir: string, usernameRaw: string, password: string): Promise<{
    username: string;
    account_id: string;
}>;
export declare function setAccountPassword(rootDir: string, usernameRaw: string, password: string): Promise<void>;
export declare function deleteAccount(rootDir: string, usernameRaw: string): Promise<void>;
export declare function authenticateAccount(rootDir: string, usernameRaw: string, password: string): Promise<string | null>;
export declare function bindCloudflareEmail(rootDir: string, usernameRaw: string, emailRaw: string): Promise<void>;
export declare function resolveCloudflareAccount(rootDir: string, identity: {
    sub: string;
    email: string;
}): Promise<{
    username: string;
    account_id: string;
    created: boolean;
}>;

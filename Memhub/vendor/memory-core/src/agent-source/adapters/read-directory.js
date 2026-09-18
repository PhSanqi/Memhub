import { readdir } from "node:fs/promises";
export async function readDirectoryIfExists(path) {
    try {
        return await readdir(path, { withFileTypes: true });
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}

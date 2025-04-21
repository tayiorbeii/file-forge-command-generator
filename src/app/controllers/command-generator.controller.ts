import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionConfig, EXTENSION_ID } from '../configs';
import { showError, showMessage } from '../helpers/dialog.helper';
import { existsSync } from 'fs';
import { readJsonFile } from '../helpers/filesystem.helper';

interface FileImportInfo {
  filePath: string;
  imports: string[];
  error?: string;
}

export class CommandGeneratorController {
  private _tsconfigPaths: Record<string, string[]> | undefined;
  private _tsconfigBaseUrl: string | undefined;

  constructor(private readonly config: ExtensionConfig) {
    this._initTsconfig();
  }

  private async _initTsconfig() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;
    const root = workspaceFolders[0].uri.fsPath;
    const tsconfigPath = path.join(root, 'tsconfig.json');
    const tsconfig = await readJsonFile(tsconfigPath);
    if (
      tsconfig &&
      tsconfig.compilerOptions &&
      tsconfig.compilerOptions.paths
    ) {
      this._tsconfigPaths = tsconfig.compilerOptions.paths;
      this._tsconfigBaseUrl = tsconfig.compilerOptions.baseUrl
        ? path.resolve(root, tsconfig.compilerOptions.baseUrl)
        : root;
    }
  }

  private async _getAllImportsRecursive(
    filePath: string,
    seen = new Set<string>(),
  ): Promise<string[]> {
    if (seen.has(filePath)) return [];
    seen.add(filePath);
    const info = await this._getImportsFromFile(filePath);
    let allImports = [...info.imports];
    for (const imp of info.imports) {
      const subImports = await this._getAllImportsRecursive(imp, seen);
      allImports.push(...subImports);
    }
    return [...new Set(allImports)];
  }

  async generateFileForgeCommand(): Promise<void> {
    await this._initTsconfig();
    try {
      const openFiles = this._getAllOpenFiles();
      if (openFiles.length === 0) {
        await showMessage('No files are currently open.');
        return;
      }

      // Recursively collect all imports for each open file
      const allFilesSet = new Set<string>(openFiles);
      for (const file of openFiles) {
        const imports = await this._getAllImportsRecursive(file);
        imports.forEach((imp) => allFilesSet.add(imp));
      }
      const allFiles = Array.from(allFilesSet);
      if (allFiles.length === 0) {
        await showMessage('No files found to include.');
        return;
      }

      // Build a map of import origins: for each file, which open file(s) import it (directly or transitively)
      const importOrigins: Record<string, Set<string>> = {};
      for (const openFile of openFiles) {
        const imports = await this._getAllImportsRecursive(openFile);
        for (const imp of imports) {
          if (!importOrigins[imp]) importOrigins[imp] = new Set();
          importOrigins[imp].add(openFile);
        }
      }
      // Also mark open files as their own origin
      for (const openFile of openFiles) {
        if (!importOrigins[openFile]) importOrigins[openFile] = new Set();
        importOrigins[openFile].add(openFile);
      }

      // Sort files by path, then by file name
      allFiles.sort((a, b) => {
        const pathA = a.toLowerCase();
        const pathB = b.toLowerCase();
        if (pathA === pathB) return 0;
        if (pathA < pathB) return -1;
        return 1;
      });

      // Multi-select quick pick for all files (open + imports)
      // Annotate with which open file(s) import it
      const quickPickItems: vscode.QuickPickItem[] = allFiles.map(
        (filePath) => {
          const origins = importOrigins[filePath]
            ? Array.from(importOrigins[filePath])
            : [];
          const importedFrom =
            origins.length > 0
              ? `Imported from: ${origins
                  .map((o) => path.basename(o))
                  .join(', ')}`
              : undefined;
          return {
            label: path.basename(filePath),
            description: filePath,
            detail: importedFrom,
            alwaysShow: true,
          };
        },
      );

      let selected: readonly vscode.QuickPickItem[] | undefined =
        quickPickItems;
      try {
        selected = (await vscode.window.showQuickPick(quickPickItems, {
          canPickMany: true,
          title: 'Select files to include in the File Forge command',
          placeHolder:
            'Find file names, paths, or import origins (e.g. "components" or "App.tsx")',
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
          // @ts-expect-error: selectedItems is not yet in stable API, but supported in Insiders and will be stable soon
          selectedItems: quickPickItems,
        })) as readonly vscode.QuickPickItem[] | undefined;
      } catch {
        selected = quickPickItems;
      }
      if (!selected || selected.length === 0) {
        await showMessage('No files selected. Command generation cancelled.');
        return;
      }
      const selectedFiles = selected.map((item) => item.description!);

      // Only gather imports for the selected files (for error reporting, not for inclusion)
      const fileImportsPromises = selectedFiles.map(async (filePath) => {
        const allImports = await this._getAllImportsRecursive(filePath);
        return { filePath, imports: allImports };
      });
      const fileImports = await Promise.all(fileImportsPromises);
      fileImports.forEach((info) => {
        if ((info as any).error) {
          console.warn(
            `[${EXTENSION_ID}] Error parsing imports for ${info.filePath}: ${
              (info as any).error
            }`,
          );
        }
      });
      // Build the command using only the selected files
      const command = this._buildFfgCommand(
        selectedFiles.map((filePath) => ({ filePath, imports: [] })),
      );
      const result = await vscode.window.showInputBox({
        prompt: 'Copy this File Forge command to analyze selected files',
        value: command,
        ignoreFocusOut: true,
      });
      if (result !== undefined) {
        await vscode.env.clipboard.writeText(result);
        await showMessage(
          'File Forge command generated and copied to clipboard!',
        );
      } else {
        await showMessage('Command generation cancelled.');
      }
    } catch (error: any) {
      await showError(`Error generating command: ${error.message}`);
      console.error(
        `[${EXTENSION_ID}] Error in generateFileForgeCommand:`,
        error,
      );
    }
  }

  private _getAllOpenFiles(): string[] {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const openFilePaths = tabs
      .map((tab) => {
        if (tab.input instanceof vscode.TabInputText) {
          if (tab.input.uri.scheme === 'file') {
            return tab.input.uri.fsPath;
          }
        }
        // Handle diff editor tabs
        if (tab.input instanceof vscode.TabInputTextDiff) {
          if (tab.input.modified.scheme === 'file') {
            return tab.input.modified.fsPath;
          }
        }
        // Skip other tab types like custom editors
        return null;
      })
      .filter((filePath): filePath is string => filePath !== null);
    return [...new Set(openFilePaths)];
  }

  private async _getImportsFromFile(filePath: string): Promise<FileImportInfo> {
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      const fileExt = path.extname(filePath).toLowerCase();
      let imports: string[] = [];

      if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(fileExt)) {
        // Handle ES modules imports
        const esmRegex =
          /import(?:["'\s]*(?:[\w*{}\n\r\t, ]+)from\s*)?("|')(.*?)\1/g;
        let match;
        while ((match = esmRegex.exec(text)) !== null) {
          const importPath = match[2];
          if (!importPath.startsWith('.') && !this._isAliasImport(importPath))
            continue; // Skip non-relative and non-alias imports

          let resolvedPath: string | undefined;
          if (importPath.startsWith('.')) {
            resolvedPath = path.resolve(path.dirname(filePath), importPath);
          } else if (this._isAliasImport(importPath)) {
            resolvedPath = this._resolveAliasImport(importPath);
          }

          if (!resolvedPath) continue;

          const possibleExtensions = [
            '',
            '.js',
            '.jsx',
            '.ts',
            '.tsx',
            '.mjs',
            '.cjs',
          ];

          for (const ext of possibleExtensions) {
            const pathWithExt = resolvedPath + ext;
            if (existsSync(pathWithExt)) {
              imports.push(pathWithExt);
              break;
            }
            // Try with /index
            const indexPath = path.join(resolvedPath, 'index' + ext);
            if (existsSync(indexPath)) {
              imports.push(indexPath);
              break;
            }
          }
        }

        // Handle CommonJS requires
        const cjsRegex = /require\s*\(\s*(["'])(.+?)\1\s*\)/g;
        while ((match = cjsRegex.exec(text)) !== null) {
          const importPath = match[2];
          if (!importPath.startsWith('.')) continue;

          const resolvedPath = path.resolve(path.dirname(filePath), importPath);
          const possibleExtensions = [
            '.js',
            '.jsx',
            '.ts',
            '.tsx',
            '.mjs',
            '.cjs',
          ];

          // Try exact path first
          if (existsSync(resolvedPath)) {
            imports.push(resolvedPath);
            continue;
          }

          // Try with extensions
          for (const ext of possibleExtensions) {
            const pathWithExt = resolvedPath + ext;
            if (existsSync(pathWithExt)) {
              imports.push(pathWithExt);
              break;
            }

            // Try with /index
            const indexPath = path.join(resolvedPath, 'index' + ext);
            if (existsSync(indexPath)) {
              imports.push(indexPath);
              break;
            }
          }
        }
      } else if (fileExt === '.py') {
        // Handle Python imports
        const pyImportRegex =
          /^(?:from\s+(\S+)\s+import|\s*import\s+([^#\n]+))/gm;
        let match;
        while ((match = pyImportRegex.exec(text)) !== null) {
          const importPath = (match[1] || match[2]).trim().split(/\s+/)[0];
          if (!importPath.startsWith('.')) continue;

          const resolvedPath = path.resolve(
            path.dirname(filePath),
            importPath.replace(/\./g, '/'),
          );
          const possibleExtensions = ['.py'];

          // Try exact path first
          if (existsSync(resolvedPath + '.py')) {
            imports.push(resolvedPath + '.py');
            continue;
          }

          // Try as directory with __init__.py
          const initPath = path.join(resolvedPath, '__init__.py');
          if (existsSync(initPath)) {
            imports.push(initPath);
          }
        }
      }

      return {
        filePath,
        imports: [...new Set(imports)],
      };
    } catch (error: any) {
      return {
        filePath,
        imports: [],
        error: error.message,
      };
    }
  }

  private _isAliasImport(importPath: string): boolean {
    if (!this._tsconfigPaths) return false;
    return Object.keys(this._tsconfigPaths).some((alias) => {
      // Remove trailing /* for matching
      const aliasPrefix = alias.replace(/\*$/, '');
      return importPath.startsWith(aliasPrefix);
    });
  }

  private _resolveAliasImport(importPath: string): string | undefined {
    if (!this._tsconfigPaths || !this._tsconfigBaseUrl) return undefined;
    for (const [alias, targets] of Object.entries(this._tsconfigPaths)) {
      const aliasPrefix = alias.replace(/\*$/, '');
      if (importPath.startsWith(aliasPrefix)) {
        const subPath = importPath.substring(aliasPrefix.length);
        // Only handle first target for now
        const target = targets[0];
        if (!target) continue;
        const targetPrefix = target.replace(/\*$/, '');
        return path.resolve(this._tsconfigBaseUrl, targetPrefix + subPath);
      }
    }
    return undefined;
  }

  private _buildFfgCommand(fileImports: FileImportInfo[]): string {
    let command = 'ffg';
    const allFiles = new Set<string>();

    // Add initial files
    fileImports.forEach((info) => {
      if (!info.error) {
        allFiles.add(info.filePath);
        // Add all imported files
        info.imports.forEach((importPath) => allFiles.add(importPath));
      }
    });

    const filesArr = Array.from(allFiles);
    if (filesArr.length === 0) {
      return "echo 'No valid files found to generate ffg command.'";
    }

    // Always use multiple --include flags, one for each file
    filesArr.forEach((file) => {
      command += ` --include "${file}"`;
    });

    // Use a short, date-time-based filename for output
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate(),
    )}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputFilename = `.ffg/ffg_output_${dateStr}.md`;
    command += ` --output ${outputFilename}`;

    command += ' --markdown';
    command += ' --whitespace';
    command += ' --clipboard';
    return command;
  }
}

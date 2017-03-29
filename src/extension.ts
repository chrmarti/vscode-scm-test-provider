/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, ExtensionContext, EventEmitter, SCMResourceGroup, Uri, SCMProvider, CancellationToken, commands, scm, window } from 'vscode';
import { stat, readFile, writeFile, unlink } from 'fs';
import { join, dirname } from 'path';

export async function activate(context: ExtensionContext) {
    if (!workspace.rootPath) {
        return;
    }
    
    const emitter = new EventEmitter();
    const workingDir: SCMResourceGroup = {
        uri: Uri.parse('baseFolderScm:workingDir'),
        label: 'Working Dir',
        resources: []
    };
    const provider: SCMProvider = {
        label: '.base Folder',
        resources: [ workingDir ],
        onDidChange: emitter.event,
        provideOriginalResource: async (uri: Uri, token: CancellationToken) => {
            const base = toBaseUri(uri);
            return (await exists(base)) ? base : null;
        },
        open: async resource => {
            const workUri = resource.sourceUri;
            const workExists = await exists(workUri);
            const baseUri = toBaseUri(workUri);
            const baseExists = await exists(baseUri);
            if (baseExists && workExists) {
                return await commands.executeCommand<void>('vscode.diff', baseUri, workUri, workUri.toString());
            } else if (workExists) {
                return await commands.executeCommand<void>('vscode.open', workUri);
            } else if (baseExists) {
                return await commands.executeCommand<void>('vscode.open', baseUri);
            }
        },
        contextKey: 'baseFolder'
    };
    context.subscriptions.push(scm.registerSCMProvider(provider));

    context.subscriptions.push(commands.registerCommand('baseFolderScm.revert', async (resource: Uri) => {
        const workUris = resource.toString() === workingDir.uri.toString() ? workingDir.resources.map(resource => resource.sourceUri) : [resource];
        for (const work of workUris) {
            const base = toBaseUri(work);
            const baseExists = await exists(base);
            if (baseExists) {
                await storeContent(work, await loadContent(base));
            } else {
                await deleteFile(work);
            }
        }
        await update(provider, emitter);
    }));

    context.subscriptions.push(commands.registerCommand('baseFolderScm.commit', async (resource: Uri) => {
        const workUris = resource.toString() === workingDir.uri.toString() ? workingDir.resources.map(resource => resource.sourceUri) : [resource];
        for (const work of workUris) {
            const base = toBaseUri(work);
            const workspaceExists = await exists(work);
            if (workspaceExists) {
                await storeContent(base, await loadContent(work));
            } else {
                await deleteFile(base);
            }
        }
        await update(provider, emitter);
    }));

    context.subscriptions.push(commands.registerCommand('baseFolderScm.refresh', async (resource: Uri) => {
        await update(provider, emitter);
    }));

    scm.onDidAcceptInputValue(input => {
        window.showInformationMessage(`Message: ${input.value}`);
        input.value = '';
    });

    scm.onDidChangeActiveProvider(provider => {
        window.showInformationMessage(`Switched to: ${provider.label}`);
    });

    await update(provider, emitter);
}

async function update(provider: SCMProvider, emitter: EventEmitter<SCMProvider>) {
    let [workspaceUris, baseUris] = await Promise.all([
        workspace.findFiles('**/*', '.base/**/*'),
        workspace.findFiles('.base/**/*'),
    ]);
    baseUris = baseUris.map(uri => toWorkspaceUri(uri));
    const workspaceMap: { [k: string]: boolean; } = workspaceUris.reduce((map, uri) => ({ ...map, [uri.toString()]: true }), {});
    const baseMap: { [k: string]: boolean; } = baseUris.reduce((map, uri) => ({ ...map, [uri.toString()]: true }), {});
    const additions = workspaceUris.filter(uri => !baseMap[uri.toString()]);
    const deletions = baseUris.filter(uri => !workspaceMap[uri.toString()]);
    const common = baseUris.filter(uri => workspaceMap[uri.toString()]);
    const resources = provider.resources[0].resources;
    resources.splice(0, resources.length, ...additions.map(uri => ({
        uri: uri.with({ scheme: 'baseFolderScm' }),
        sourceUri: uri,
        decorations: {
            dark: { iconPath: getIconUri('status-added', 'dark') },
            light: { iconPath: getIconUri('status-added', 'light') }
        }
    })), ...deletions.map(uri => ({
        uri: uri.with({ scheme: 'baseFolderScm' }),
        sourceUri: uri,
        decorations: {
            strikeThrough: true,
            dark: { iconPath: getIconUri('status-deleted', 'dark') },
            light: { iconPath: getIconUri('status-deleted', 'light') }
        }
    })), ...common.map(uri => ({
        uri: uri.with({ scheme: 'baseFolderScm' }),
        sourceUri: uri,
        decorations: {
            dark: { iconPath: getIconUri('status-modified', 'dark') },
            light: { iconPath: getIconUri('status-modified', 'light') }
        }
    })));
    emitter.fire(provider);
}

function toWorkspaceUri(uri: Uri) {
    return uri.with({ path: workspace.rootPath + '/' + uri.path.substr((workspace.rootPath + '/.base/').length) });
}

function toBaseUri(uri: Uri) {
    return uri.with({ path: workspace.rootPath + '/.base/' + uri.path.substr((workspace.rootPath + '/').length) });
}

async function exists(uri: Uri): Promise<boolean> {
    return await new Promise<boolean>((resolve, reject) => {
        stat(uri.fsPath, (err, stat) => {
            resolve(!err && stat.isFile());
        });
    });
}

async function equalContent(left: Uri, right: Uri): Promise<boolean> {
    const [leftContent, rightContent] = await Promise.all([loadContent(left), loadContent(right)]);
    return leftContent === rightContent;
}

async function loadContent(uri: Uri): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        readFile(uri.fsPath, { encoding: 'utf8' }, (err, content) => {
            if (err) {
                reject(err);
            } else {
                resolve(content);
            }
        });
    });
}

async function storeContent(uri: Uri, data: string): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        writeFile(uri.fsPath, data, { encoding: 'utf8' }, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

async function deleteFile(uri: Uri) {
    return await new Promise<void>((resolve, reject) => {
        unlink(uri.fsPath, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

const iconsRootPath = join(dirname(__dirname), '..', 'resources', 'icons');

function getIconUri(iconName: string, theme: string): Uri {
    return Uri.file(join(iconsRootPath, theme, `${iconName}.svg`));
}

export function deactivate() {
}

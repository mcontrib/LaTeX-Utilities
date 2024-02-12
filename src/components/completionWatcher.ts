import * as vscode from 'vscode'
import { Extension } from '../main'
import { TypeFinder } from './typeFinder'
import { exec } from 'child_process'
import * as path from 'path'
import { existsSync, readFileSync } from 'fs'
import { removeSync } from 'fs-extra'

interface ISnippet {
    prefix: RegExp
    body: string
    description?: string
    priority?: number
    triggerWhenComplete?: boolean
    mode?: 'maths' | 'text' | 'any'
    noPlaceholders?: boolean
}

interface ISnippetConfig {
    prefix: string
    body: string
    description?: string
    priority?: number
    triggerWhenComplete?: boolean
    mode?: 'maths' | 'text' | 'any'
    noPlaceholders?: boolean
}

const DEBUG_CONSOLE_LOG = false

/* eslint-disable */
let debuglog: (icon: string, start: number, action: string) => void;
if (DEBUG_CONSOLE_LOG) {
    debuglog = function (icon, start, action) {
        console.log(`${icon} Watcher took ${+new Date() - start}ms ${action}`);
    };
} else {
    debuglog = (_i, _s, _a) => {};
}
/* eslint-enable */
export class CompletionWatcher {
    extension: Extension
    typeFinder: TypeFinder
    private lastChanges: vscode.TextDocumentChangeEvent | undefined
    private lastKnownType:
        | {
              position: vscode.Position
              mode: 'maths' | 'text'
          }
        | undefined
    currentlyExecutingChange = false
    private enabled: boolean
    private configAge: number
    private MAX_CONFIG_AGE = 5000
    snippets: ISnippet[] = []
    snippetsConfig: ISnippetConfig[] = []
    activeSnippets: vscode.CompletionItem[] = []

    constructor(extension: Extension) {
        this.extension = extension
        this.typeFinder = new TypeFinder()
        this.enabled = vscode.workspace.getConfiguration('latex-utilities').get('liveReformat.enabled') as boolean
        this.configAge = +new Date()
        vscode.workspace.onDidChangeTextDocument(this.watcher, this)

        if (existsSync(this.getUserSnippetsFile())) {
            this.extension.logger.addLogMessage('User Snippets File Found, migrating to new config')
            const snippets = JSON.parse(readFileSync(this.getUserSnippetsFile(), { encoding: 'utf8' }))
            this.extension.logger.addLogMessage('User Snippets File Read')
            this.extension.logger.addLogMessage(JSON.stringify(snippets))
            // update config
            vscode.workspace.getConfiguration('latex-utilities').update('liveReformat.snippets', snippets, true)
            // remove user snippets file
            removeSync(this.getUserSnippetsFile())
            this.extension.logger.addLogMessage('User Snippets File Migrated')
        }
        this.loadSnippets()
        extension.logger.addLogMessage('Completion Watcher Initialised')
    }

    private processSnippets() {
        for (let i = 0; i < this.snippets.length; i++) {
            const snippet = this.snippets[i]
            if (!/\$\$(?:\d|{\d)/.test(snippet.body) && snippet.noPlaceholders === undefined) {
                snippet.noPlaceholders = true
                if (snippet.priority === undefined) {
                    snippet.priority = -0.1
                }
            }
            if (snippet.priority === undefined) {
                snippet.priority = 0
            }
            if (snippet.triggerWhenComplete === undefined) {
                snippet.triggerWhenComplete = false
            }
            if (snippet.mode === undefined) {
                snippet.mode = 'any'
            } else if (!/^maths|text|any$/.test(snippet.mode)) {
                this.extension.logger.addLogMessage(
                    `Invalid mode (${snippet.mode}) for live snippet "${snippet.description}"`
                )
            }
        }
        this.snippets.sort((a, b) => {
            return (b.priority === undefined ? 0 : b.priority) - (a.priority === undefined ? 0 : a.priority)
        })
    }

    public async watcher(e: vscode.TextDocumentChangeEvent) {
        if (+new Date() - this.configAge > this.MAX_CONFIG_AGE) {
            this.enabled = vscode.workspace.getConfiguration('latex-utilities').get('liveReformat.enabled') as boolean
            this.loadSnippets()
            this.configAge = +new Date()
        }

        if (
            ['latex', 'rsweave', 'jlweave'].findIndex(item => item === e.document.languageId) < 0 ||
            e.contentChanges.length === 0 ||
            this.currentlyExecutingChange ||
            this.sameChanges(e) ||
            !this.enabled ||
            !vscode.window.activeTextEditor
        ) {
            return
        }

        this.lastChanges = e
        this.activeSnippets = []

        const start = +new Date()
        let columnOffset = 0
        for (const change of e.contentChanges) {
            const type = this.typeFinder.getTypeAtPosition(e.document, change.range.start, this.lastKnownType)
            this.lastKnownType = { position: change.range.start, mode: type }
            if (change.range.isSingleLine) {
                let line = e.document.lineAt(change.range.start.line)
                for (let i = 0; i < this.snippets.length; i++) {
                    if (this.snippets[i].mode === 'any' || this.snippets[i].mode === type) {
                        const newColumnOffset = await this.execSnippet(this.snippets[i], line, change, columnOffset)
                        if (newColumnOffset === 'break') {
                            break
                        } else if (newColumnOffset !== undefined) {
                            columnOffset += newColumnOffset
                            line = e.document.lineAt(change.range.start.line)
                        }
                    }
                }
            }
        }
        this.extension.telemetryReporter.sendTelemetryEvent('liveSnippetTimings', {
            timeToCheck: (start - +new Date()).toString()
        })
        debuglog('🔵', start, 'to check for snippets')
    }

    private sameChanges(changes: vscode.TextDocumentChangeEvent) {
        if (!this.lastChanges) {
            return false
        } else if (this.lastChanges.contentChanges.length !== changes.contentChanges.length) {
            return false
        } else {
            const changeSame = this.lastChanges.contentChanges.every((value, index) => {
                const newChange = changes.contentChanges[index]
                if (value.text !== newChange.text || !value.range.isEqual(newChange.range)) {
                    return false
                }

                return true
            })
            if (!changeSame) {
                return false
            }
        }

        return true
    }

    private async execSnippet(
        snippet: ISnippet,
        line: vscode.TextLine,
        change: vscode.TextDocumentContentChangeEvent,
        columnOffset: number
    ): Promise<number | 'break' | undefined> {
        return new Promise((resolve, reject) => {
            const match = snippet.prefix.exec(
                line.text.substr(0, change.range.start.character + change.text.length + columnOffset)
            )
            if (match && vscode.window.activeTextEditor) {
                let matchRange: vscode.Range
                let replacement: string
                if (snippet.body === 'SPECIAL_ACTION_BREAK') {
                    resolve('break')
                    return
                } else if (snippet.body === 'SPECIAL_ACTION_FRACTION') {
                    [matchRange, replacement] = this.getFraction(match, line)
                } else {
                    matchRange = new vscode.Range(
                        new vscode.Position(line.lineNumber, match.index),
                        new vscode.Position(line.lineNumber, match.index + match[0].length)
                    )
                    if (snippet.body === 'SPECIAL_ACTION_SYMPY') {
                        replacement = this.execSympy(match, line)
                    } else {
                        replacement = match[0].replace(snippet.prefix, snippet.body).replace(/\$\$/g, '$')
                    }
                }
                if (snippet.triggerWhenComplete) {
                    this.currentlyExecutingChange = true
                    const changeStart = +new Date()
                    if (snippet.noPlaceholders) {
                        vscode.window.activeTextEditor
                            .edit(
                                editBuilder => {
                                    editBuilder.replace(matchRange, replacement)
                                },
                                { undoStopBefore: true, undoStopAfter: true }
                            )
                            .then(() => {
                                const offset = replacement.length - match[0].length
                                if (vscode.window.activeTextEditor && offset > 0) {
                                    vscode.window.activeTextEditor.selection = new vscode.Selection(
                                        vscode.window.activeTextEditor.selection.anchor.translate(0, offset),
                                        vscode.window.activeTextEditor.selection.anchor.translate(0, offset)
                                    )
                                }
                                this.currentlyExecutingChange = false
                                debuglog(' ▹', changeStart, 'to perform text replacement')
                                resolve(offset)
                            })
                    } else {
                        vscode.window.activeTextEditor
                            .edit(
                                editBuilder => {
                                    editBuilder.delete(matchRange)
                                },
                                { undoStopBefore: true, undoStopAfter: false }
                            )
                            .then(
                                () => {
                                    if (!vscode.window.activeTextEditor) {
                                        return
                                    }
                                    vscode.window.activeTextEditor
                                        .insertSnippet(new vscode.SnippetString(replacement), undefined, {
                                            undoStopBefore: true,
                                            undoStopAfter: true
                                        })
                                        .then(
                                            () => {
                                                this.currentlyExecutingChange = false
                                                debuglog(' ▹', changeStart, 'to insert snippet')
                                                resolve(replacement.length - match[0].length)
                                            },
                                            (reason: unknown) => {
                                                this.currentlyExecutingChange = false
                                                reject(reason)
                                            }
                                        )
                                },
                                (reason: unknown) => {
                                    this.currentlyExecutingChange = false
                                    reject(reason)
                                }
                            )
                    }
                } else {
                    this.activeSnippets.push({
                        label: replacement,
                        filterText: match[0],
                        sortText: match[0],
                        range: matchRange,
                        detail: 'live snippet',
                        kind: vscode.CompletionItemKind.Reference
                    })
                }
            } else {
                resolve(undefined)
            }
        })
    }

    public provide(): vscode.CompletionItem[] {
        return this.activeSnippets
    }

    public editSnippetsFile() {
        vscode.commands.executeCommand('workbench.action.openSettingsJson', {
            revealSetting: {
                key: 'latex-utilities.liveReformat.snippets',
                edit: true,
            }
        })
    }

    public loadSnippets() {
        // if this.snippetsConfig is same with getConfiguration, skip
        if (JSON.stringify(this.snippetsConfig) === JSON.stringify(vscode.workspace.getConfiguration('latex-utilities').get('liveReformat.snippets'))) {
            return
        }
        this.snippetsConfig = vscode.workspace.getConfiguration('latex-utilities').get('liveReformat.snippets') as ISnippetConfig[]
        try {
            this.snippets = []
            for (let i = 0; i < this.snippetsConfig.length; i++) {
                // snippets[i].prefix = new RegExp(snippets[i].prefix);
                this.snippets.push({
                    ...this.snippetsConfig[i],
                    prefix: new RegExp(this.snippetsConfig[i].prefix)
                })
            }
            this.processSnippets()
        } catch (error) {
            this.extension.logger.logError(error)
            this.extension.logger.showErrorMessage('Couldn\'t load snippets file. Is it a valid JSON?')
        }
    }

    private getUserSnippetsFile() {
        const codeFolder = vscode.version.indexOf('insider') >= 0 ? 'Code - Insiders' : 'Code'
        const templateName = 'latexUtilsLiveSnippets.json'

        if (process.platform === 'win32' && process.env.APPDATA) {
            return path.join(process.env.APPDATA, codeFolder, 'User', templateName)
        } else if (process.platform === 'darwin' && process.env.HOME) {
            return path.join(process.env.HOME, 'Library', 'Application Support', codeFolder, 'User', templateName)
        } else if (process.platform === 'linux' && process.env.HOME) {
            let conf = path.join(process.env.HOME, '.config', codeFolder, 'User', templateName)
            if (existsSync(conf)) {
                return conf
            } else {
                conf = path.join(process.env.HOME, '.config', 'Code - OSS', 'User', templateName)
                return conf
            }
        } else {
            return ''
        }
    }

    private getFraction(match: RegExpExecArray, line: vscode.TextLine): [vscode.Range, string] {
        type TclosingBracket = ')' | ']' | '}'
        type TopeningBracket = '(' | '[' | '{'
        const closingBracket = match[1] as TclosingBracket
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const openingBracket = { ')': '(', ']': '[', '}': '{' }[closingBracket] as TopeningBracket
        let depth = 0
        for (let i = match.index; i >= 0; i--) {
            if (line.text[i] === closingBracket) {
                depth--
            } else if (line.text[i] === openingBracket) {
                depth++
            }
            if (depth === 0) {
                // if command keep going till the \
                const commandMatch = /.*(\\\w+)$/.exec(line.text.substr(0, i))
                if (closingBracket === '}') {
                    if (commandMatch !== null) {
                        i -= commandMatch[1].length
                    }
                }
                const matchRange = new vscode.Range(
                    new vscode.Position(line.lineNumber, i),
                    new vscode.Position(line.lineNumber, match.index + match[0].length)
                )
                const replacement = `\\frac{${commandMatch ? '\\' : ''}${line.text.substring(i + 1, match.index)}}{$1} `
                return [matchRange, replacement]
            }
        }
        return [
            new vscode.Range(
                new vscode.Position(line.lineNumber, match.index + match[0].length),
                new vscode.Position(line.lineNumber, match.index + match[0].length)
            ),
            ''
        ]
    }

    private execSympy(match: RegExpExecArray, line: vscode.TextLine) {
        const replacement = 'SYMPY_CALCULATING'
        const command = match[1]
            .replace(/\\(\w+) ?/g, '$1')
            .replace(/\^/, '**')
            .replace('{', '(')
            .replace('}', ')')
        exec(
            `python3 -c "from sympy import *
import re
a, b, c, x, y, z, t = symbols('a b c x y z t')
k, m, n = symbols('k m n', integer=True)
f, g, h = symbols('f g h', cls=Function)
init_printing()
print(eval('''latex(${command})'''), end='')"`,
            { encoding: 'utf8' },
            (_error, stdout, stderr) => {
                if (!vscode.window.activeTextEditor) {
                    return
                } else if (stderr) {
                    stdout = 'SYMPY_ERROR'
                    setTimeout(() => {
                        this.extension.logger.addLogMessage(`error executing sympy command: ${command}`)
                        if (!vscode.window.activeTextEditor) {
                            return
                        }

                        vscode.window.activeTextEditor.edit(editBuilder => {
                            editBuilder.delete(
                                new vscode.Range(
                                    new vscode.Position(line.lineNumber, match.index),
                                    new vscode.Position(line.lineNumber, match.index + stdout.length)
                                )
                            )
                        })
                    }, 400)
                }
                vscode.window.activeTextEditor.edit(editBuilder => {
                    editBuilder.replace(
                        new vscode.Range(
                            new vscode.Position(line.lineNumber, match.index),
                            new vscode.Position(line.lineNumber, match.index + replacement.length)
                        ),
                        stdout
                    )
                })
            }
        )
        return replacement
    }
}

export class Completer implements vscode.CompletionItemProvider {
    extension: Extension

    constructor(extension: Extension) {
        this.extension = extension
    }

    provideCompletionItems(
        /* eslint-disable @typescript-eslint/no-unused-vars */
        _document: vscode.TextDocument,
        _position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
        /* eslint-enable @typescript-eslint/no-unused-vars */
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        return this.extension.completionWatcher.activeSnippets
    }
}

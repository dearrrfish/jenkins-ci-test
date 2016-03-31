ObjC.import('Foundation')
const USER_HOME_FOLDER = ObjC.unwrap($.NSHomeDirectory())
const WORKFLOW_CONFIG_FOLDER = `${USER_HOME_FOLDER}/.config/bs-alfredworkflow`
const BROWSERS = {
    safari: ['Safari', 'Webkit'],
    chrome: ['Google Chrome', 'Google Chrome Canary', 'Chromium']
}

const SystemEvents = Application('System Events')
SystemEvents.includeStandardAdditions = true
const frontmostApp = () => SystemEvents.processes.whose({ frontmost: true })[0].name()

const FileManager = $.NSFileManager.defaultManager

let UserDefaults = null
// ================================================================================================

function getBrowser(name, browsers = Object.keys(BROWSERS), defaultBrowser) {
    name = name || defaultBrowser
    if (!name) { return [] }

    if (!Array.isArray(browsers)) { browsers = [ browsers ] }
    name = name.toLowerCase()

    if (BROWSERS[name] && BROWSERS[name].length) {
        return [ BROWSERS[name][0], name ]
    }

    for (let type of browsers) {
        if (!BROWSERS[type]) { continue }
        for (let browser of BROWSERS[type]) {
            if (name === browser.toLowerCase()) {
                return [ browser, type ]
            }
        }
    }

    return []
}


function getFromToBrowsers(from, to, reverse) {
    let fromType;

    [ from, fromType ] = getBrowser(from)
    to = getBrowser(to)[0]

    if (!from) {
        const front = frontmostApp();
        [ from, fromType ] = getBrowser(front)
        if (!from) { throw new Error(`${front} is not supported browser.`); return }
    }

    if (!to) {
        if      (fromType === 'safari') { to = getBrowser('chrome')[0] }
        else if (fromType === 'chrome') { to = getBrowser('safari')[0] }
        else { throw new Error(`${from} is not supported browser.`); return }
    }

    if (from === to) {
        throw new Error(`Source and target browsers cannot be same application.`); return
    }

    if (reverse) { [from, to] = [to, from] }

    return [ from, to ]
}


function getDefaultBrowser() {
    let app = Application.currentApplication()
    try {
        app.includeStandardAdditions = true
    }
    catch (err) {
        app = Application('Finder')
        app.includeStandardAdditions = true
    }

    return app.doShellScript(
        "export VERSIONER_PERL_PREFER_32_BIT=yes;" +
        "perl -MMac::InternetConfig -le 'print +(GetICHelper \"http\")[1]'"
    )
}


function theClipboard(sth) {
    if (sth === '__frontmostapp_selection__') {
        // Method 1: call keystroke `cmd + c` to copy text
        //SystemEvents.keystroke('c', { using: 'command down' })

        // Method 2: click menu item `Edit - Copy`
        SystemEvents.processes.whose({ frontmost: true })[0]
            .menuBars[0].menuBarItems.whose({ name: 'Edit' })[0]
            .menus[0].menuItems.whose({ name: 'Copy' })[0]
            .click()

        delay(0.1)  // wait 0.1s to let keystroke take effect
    }
    else if (sth) {
        SystemEvents.setTheClipboardTo(sth)
    }
    return SystemEvents.theClipboard()
}


function _getSelectionByCopy() {
    const clipboardBackup = theClipboard()
    theClipboard('__frontmostapp_selection__')
    let selection = theClipboard()
    // TODO better way to detect selection over this buggy workaround
    if (selection === clipboardBackup) { selection = null }
    else { theClipboard(clipboardBackup) }
    return selection
}


// propsIn: {appName}
function getApp(appName = frontmostApp(), { activate = false, appOnly = false, index } = {}) {
    appName = /^frontmostapp$/i.test(appName) ? frontmostApp() : appName

    let app = null
    try {
        app = Application(appName)
    }
    catch (err) {
        throw new Error(`Application ${appName} was not found.`)
    }

    app.includeStandardAdditions = true
    activate && app.activate()
    //activate ? (app.activate()) : (app.launch())

    if (appOnly) { return app }

    let windows, targetTab, targetTabIndex, title, url;
    try {
        windows = app.windows()
    }
    catch (err) {
        // Non-standard native app might not support, e.g. Neovim.app
        console.log(`Non-standard native app ${appName}: ${err}`)
        return [app]
    }

    const browserType = getBrowser(appName)[1]

    if (browserType === 'safari') {
        windows = windows.filter(win => win.document() !== undefined)
        if (windows.length) {
            targetTab = index > 0 ? windows[0].tabs[index-1] : windows[0].currentTab()
            if (targetTab) {
                targetTabIndex = targetTab.index()
                title = targetTab.name()
                url = targetTab.url()
            }
        }
    }
    else if (browserType === 'chrome') {
        if (windows.length) {
            targetTab = index > 0 ? windows[0].tabs[index-1] : windows[0].activeTab()
            if (targetTab) {
                targetTabIndex = windows[0].activeTabIndex()
                title = targetTab.title()
                url = targetTab.url()
            }
        }
    }

    return [app, windows, browserType, targetTab, targetTabIndex, title, url]
}


function getAppData(appName, clips = new Set(), { index, appData, stringify } = {}) {
    const data = {}
    let [
        app, windows, browserType, targetTab, targetTabIndex, title, url
    ] = (appData || getApp(appName, { index }))
    appName = app.name()

    data.appName = appName

    clips = new Set(clips)

    if (clips.has('browserType')) {
        data.browserType = browserType
    }

    // get title/name data
    if (clips.has('title') || clips.has('markdown')) {
        if (title) { data.title = title }
        else if (windows && windows[0]) { data.title = windows[0].name() }
        else { data.title = appName }
    }

    // url for browsers
    if (clips.has('url') || clips.has('markdown')) { data.url = url }

    // markdown stringify
    if (clips.has('markdown')) { data.markdown = `[${data.title}](${data.url})` }

    // selected text
    if (clips.has('selection')) {

        try {
            // do javascript trick to get selection text in browser tab
            if (targetTab) {
                // http://stackoverflow.com/questions/10990690/content-getselection-is-not-working-when-selected-text-is-in-iframe
                const js = "function _getSelection(w){var r=w.getSelection();for(var i=0;!r&&i<w.frames.length;i++){r=_getSelection(w.frames[i])}return r;}''+_getSelection(window)"
                if (browserType === 'safari') {
                    data.selection = app.doJavaScript(js, { in: targetTab })
                }
                else if (browserType === 'chrome') {
                    data.selection = targetTab.execute({ javascript: js })
                }

                if (data.selection[0] === '\u0001') {
                    const frontApp = frontmostApp()
                    app.activate()
                    delay(0.1)  // make sure target app goes frontmost
                    data.selection = _getSelectionByCopy()
                    if (app.name() !== frontApp) {
                        getApp(frontApp, { activate: true, appOnly: true })
                    }
                }
            }

            else if (app.frontmost()) {
                data.selection = _getSelectionByCopy()
            }
        }
        catch (err) {
            throw new Error(`Unable to get selection in ${appName}`)
        }
    }

    // From here, rest flags require native window interface
    if (!Array.isArray(windows) || !windows.length) {
        // Just return empty data instead when no active window detected,
        // or because it does not support standard suite
        return data
        //throw new Error(`No active window was found in ${appName}`)
    }

    // all tabs
    if (clips.has('tabs')) {
        if (browserType === 'safari') {
            data.tabs = windows[0].tabs().map((t, i) => ({
                browser: appName,
                browserType,
                url: t.url(),
                title: t.name(),
                index: t.index(),
                id: null,
                active: targetTabIndex === t.index()
            }))
        }
        else if (browserType === 'chrome') {
            data.tabs = windows[0].tabs().map((t, i) => ({
                browser: appName,
                browserType,
                url: t.url(),
                title: t.title(),
                index: i+1,
                id: t.id(),
                active: targetTabIndex === i+1
            }))
        }
        else {
            data.tabs = []
        }

        if (stringify) { data.tabs = JSON.stringify(data.tabs) }
    }

    return data
}


function closeTab(appName, { closeWindow = false, index } = {}) {
    const [ app, windows, browserType, targetTab ] = getApp(appName, { index: index })
    appName = app.name()
    try {
        if (windows.length && closeWindow) { app.close(windows[0]) }
        else if (targetTab) { app.close(targetTab) }
        else { throw new Error(`${appName} is not a browser or not supported yet.`) }
    }
    catch (err) {
        throw new Error(`Unable to close tab in ${appName}`)
    }

}


function openUrl(_url, target, { activate = true, dedupe, newTab = true, background, appData, noValidation } = {}) {
    let url = _url
    if (!noValidation) {
        url = validateUrl(_url)
        if (!url) { throw new Error(`No valid URL was detected in text: ${_url}`) }
        if (!/^https?:\/\//i.test(url)) { url = 'http://' + url }
    }

    if (!appData) {
        target = getBrowser(target)[0] || getDefaultBrowser()
        appData = getApp(target, { activate })
    }

    let [app, windows, browserType, frontTab] = appData
    let appName = app.name()

    // create new window if no valid ones
    if (!windows.length) {
        (browserType === 'safari') ? app.Document().make() : app.Window().make()
        app.windows[0].tabs[0].url = url
        return [url, appName]
    }

    let exists = false

    if (dedupe) {
        windows.some((win) => {
            win.tabs().some((tab, i) => {
                //console.log(tab.url(), ' ??? ', url)
                let tabUrl = tab.url()
                if (typeof tabUrl === 'string') {
                    tabUrl = tabUrl.replace(/[\/?&]+$/, '').toLowerCase()
                    const cleanUrl = url.replace(/[\/?&]+$/, '').toLowerCase()
                    if (tabUrl === cleanUrl) {
                        exists = [win, tab, i + 1];
                        return true
                    }
                }

                return exists   // false
            })

            return exists   // false
        })
    }

    exists = exists || [windows[0]]
    let [win, tab, tabIndex] = exists

    if (!tab) {
        if (newTab) {
            tab = app.Tab({ url: url })
            tabIndex = win.tabs.push(tab)
        }
        else {
            frontTab && (frontTab.url = url)
        }
    }

    //if (!tab) { throw new Error(`Unable to create tab in ${appName}`) }

    if (!background && tab) {
        if (browserType === 'safari') {
            win.currentTab = tab
        }
        else if (browserType === 'chrome' && tabIndex) {
            win.activeTabIndex = tabIndex
        }
    }

    // always bring window to front within app
    win.index = 1

    return [url, appName]
}

function openUrls(urls, target, { activate = true, dedupe, newWindow, background, noValidation } = {}) {
    target = getBrowser(target)[0] || getDefaultBrowser()
    let appData = getApp(target, { activate })
    let [ app, windows, browserType ] = appData

    if (!windows.length || newWindow) {
        browserType === 'safari' ? app.Document().make() : app.Window().make()
        delay(0.1)
        appData = getApp(target, { activate })
    }

    let appName
    urls.forEach((url, i) => {
        const newTab = (i !== 0);
        [ url, appName ] = openUrl(url, target, { dedupe, appData, newTab, background, noValidation })
    })

    return [urls, appName]
}


// http://forums.devshed.com/javascript-development-115/regexp-to-match-url-pattern-493764.html
// https://github.com/ttscoff/popclipextensions/blob/master/OpenURLS.popclipext/openurls.rb
function validateUrl(str, all, debug) {
    const urls = []
    if (typeof str === 'string') {
        const re = new RegExp(
            '(?:(?:https?:\\/\\/))?' + // protocol
            '(localhost|' + // local host
            '(([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|' + // domain name
            '((\\d{1,3}\\.){3}\\d{1,3}))' + // OR ip (v4) address
            '(:\\d+)?(\\/[-a-z\\d%_.~+]*)*' + // port and path
            '(\\?[;&a-z\\d%_.~+=-]*)?' + // query string
            '(\\#[-a-z\\d_]*)?' // fragment locater
            , 'ig')

        let match = re.exec(str)
        while (match) {
            if (debug) { console.log(match) }
            if (typeof match[0] === 'string') {
                urls.push(match[0])
                if (!all) { break }
            }
            match = re.exec(str)
        }
    }
    return all ? urls : urls[0]
}


function extractFilePath(fileName, absoulte = false) {
    let path = fileName.substring(0, fileName.lastIndexOf('/'))
    fileName = fileName.substring(fileName.lastIndexOf('/') + 1)
    if (!absoulte) {
        if (path[0] !== '/') { path = '/' + path }
        path = WORKFLOW_CONFIG_FOLDER + path
    }
    return [ path, fileName ]
}


//function listFilesInPath(path, absoulte = false) {
    //path = extractFilePath(path, absoulte).join('/')
    //const contents = FileManager.contentsOfDirectoryAtPathError(path, null)
    //return ObjC.unwrap(contents).map(c => ObjC.unwrap(c))
//}


function readFromFile(file, absoulte = false) {
    const path = extractFilePath(file, absoulte).join('/')
    let content = FileManager.contentsAtPath(path)
    content = $.NSString.alloc.initWithDataEncoding(content, $.NSUTF8StringEncoding)
    return ObjC.unwrap(content)
}

function writeToFile(content, file, absoulte = false) {
    const [ path, fileName ] = extractFilePath(file, absoulte)

    // make sure target folder exists or created
    FileManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        path, true, {}, null
    )

    content = $.NSString.alloc.initWithUTF8String(JSON.stringify(content))
    content.writeToFileAtomically((path + '/' + fileName), true)
}


function getUserDefaults(name, type, key) {
    if (!UserDefaults) {
        try {
            UserDefaults = JSON.parse(readFromFile('config.json'))
        }
        catch (err) {
           console.log('Failed to read user config file.', err)
        }
        UserDefaults = UserDefaults || {}
    }

    const value = ((UserDefaults[name] || {})[type] || {})[key]
    return value
}

function setUserDefaults(name, type, key, value) {
    const oldValue = getUserDefaults(name, type, key)
    if (oldValue !== value) {
        UserDefaults[name] = UserDefaults[name] || {}
        UserDefaults[name][type] = UserDefaults[name][type] || {}
        UserDefaults[name][type][key] = type === 'flags' ? isTrue(value) : value

        writeToFile(UserDefaults, 'config.json')
        return [key, value]
    }
    return []
}


function getTester(str, t) {
    if (t instanceof RegExp) {
        return function(s) { return t.test(s) }
    }
    else if (typeof t === 'number' && t > 0) {
        return function(s) {
            const re = new RegExp(`^${str.slice(0, t)}${Array.from(str.slice(t)).join('?')}?$`, 'i')
            return re.test(s)
        }
    }
    else if (typeof t === 'string') {
        let [ type, flag ] = t.split('_')
        if (type === 'fuzzy') {
            return function(s) {
                for (let c of s) {
                    const re = new RegExp(c, flag)
                    const found = re.exec(str)
                    if (!found) { return false }
                    str = str.slice(found.index + 1)
                }
                return true
            }
        }
        else if (type === 'words') {
            return function(s) {
                const ss = s.split(/\s+/)
                return ss.every(_s => {
                    //_s = _s.replace(/[^\w_-@]/g, '')
                    const re = new RegExp(_s, flag)
                    return re.test(str)
                })
            }
        }
        else {
            return function(s) {
                const re = new RegExp(s, flag)
                return re.test(str)
            }
        }
    }
    else {
        return function(s) { return s === str }
    }

}


function isTrue(val) {
    switch (typeof val) {
        case 'string':
            return val !== '' && !/^(false|no|off|ko)$/i.test(val)

        case 'number':
            return val > 0

        case 'boolean':
            return val

        default:
            return val != null
    }
}

function logError(err) {
    console.log(`${err.toString()} [${err.line}:${err.column}] ${err.stack}`)
}

export {
    BROWSERS, getBrowser, getFromToBrowsers,
    SystemEvents, frontmostApp, theClipboard,
    getDefaultBrowser, getApp, getAppData,
    openUrl, openUrls, validateUrl, closeTab,
    readFromFile, writeToFile,
    getUserDefaults, setUserDefaults,
    getTester, isTrue, logError
}


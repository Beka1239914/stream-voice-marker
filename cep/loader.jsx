/* Explicit UTF-8 and global scope, including on a fresh Premiere launch. */
(function () {
    try {
        var root = $._SVMExtensionRoot || new File($.fileName).parent.fsName;
        $._SVMExtensionRoot = root;
        var files = ['vendor/json2.js', 'jump-timeline.jsx', 'nest.jsx', 'host.jsx'];
        for (var i = 0; i < files.length; i++) {
            var file = new File(root + '/' + files[i]);
            file.encoding = 'UTF8';
            if (!file.open('r')) { throw new Error('Cannot open ' + file.fsName); }
            var code = file.read(); file.close();
            $.global.eval(code);
        }
        $._SVMLoadError = null;
        return 'SVM_READY';
    } catch (e) {
        $._SVMLoadError = String(e) + ' line ' + e.line;
        return 'SVM_ERROR:' + $._SVMLoadError;
    }
}());

#import <Cocoa/Cocoa.h>

static NSURL *canonicalURL(NSURL *url) {
    return url.URLByResolvingSymlinksInPath.URLByStandardizingPath;
}

static void showFailure(NSString *message, NSURL *logURL) {
    [NSApp activateIgnoringOtherApps:YES];
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"EventLens 启动失败";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"关闭"];
    BOOL hasLog = logURL && [[NSFileManager defaultManager] isReadableFileAtPath:logURL.path];
    if (hasLog) [alert addButtonWithTitle:@"查看日志"];
    if ([alert runModal] == NSAlertSecondButtonReturn && hasLog) {
        [[NSWorkspace sharedWorkspace] openURL:logURL];
    }
}

static BOOL canReadProject(NSURL *root, NSError **error) {
    return [NSData dataWithContentsOfURL:[root URLByAppendingPathComponent:@"start.sh"]
                               options:NSDataReadingUncached error:error] != nil;
}

static BOOL requestProjectAccess(NSURL *root, NSError **error) {
    if (canReadProject(root, error)) return YES;
    if ((*error).code != NSFileReadNoPermissionError) return NO;

    // 原生应用负责访问目录，让 TCC 正确归属权限；拒绝后可由用户选择项目目录授权。
    [NSApp activateIgnoringOtherApps:YES];
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = @"允许 EventLens 访问项目文件夹";
    panel.message = @"请选择下方的项目文件夹并点击“允许访问”。无需移动项目或授予完全磁盘访问权限。";
    panel.prompt = @"允许访问";
    panel.directoryURL = root;
    panel.canChooseDirectories = YES;
    panel.canChooseFiles = NO;
    panel.allowsMultipleSelection = NO;
    panel.canCreateDirectories = NO;
    if ([panel runModal] != NSModalResponseOK) return NO;
    if (![canonicalURL(panel.URL) isEqual:canonicalURL(root)]) {
        *error = [NSError errorWithDomain:NSCocoaErrorDomain code:NSFileReadNoPermissionError
                                userInfo:@{NSLocalizedDescriptionKey: @"请选择包含此应用和 start.sh 的项目文件夹。"}];
        return NO;
    }
    return canReadProject(root, error);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSURL *root = NSBundle.mainBundle.bundleURL.URLByDeletingLastPathComponent;
        NSError *error = nil;
        if (!requestProjectAccess(root, &error)) {
            showFailure([NSString stringWithFormat:@"无法读取项目文件夹：%@\n%@\n请保留应用与 start.sh 在同一文件夹，并允许访问该文件夹。",
                         root.path, error.localizedDescription ?: @"未获得目录访问授权"], nil);
            return 1;
        }

        NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
        NSString *dataPath = environment[@"EVENTLENS_DATA_DIR"] ?: [root.path stringByAppendingPathComponent:@"data"];
        if (![dataPath isAbsolutePath]) dataPath = [root.path stringByAppendingPathComponent:dataPath];
        NSURL *dataURL = [NSURL fileURLWithPath:dataPath isDirectory:YES];
        NSFileManager *files = NSFileManager.defaultManager;
        if (![files createDirectoryAtURL:dataURL withIntermediateDirectories:YES attributes:nil error:&error]) {
            showFailure([NSString stringWithFormat:@"无法写入运行数据目录：%@\n%@", dataPath, error.localizedDescription], nil);
            return 1;
        }
        NSURL *logURL = [dataURL URLByAppendingPathComponent:@"desktop-launch.log"];
        if (![files fileExistsAtPath:logURL.path]) [files createFileAtPath:logURL.path contents:nil attributes:nil];
        NSFileHandle *log = [NSFileHandle fileHandleForWritingToURL:logURL error:&error];
        if (!log) {
            showFailure([NSString stringWithFormat:@"无法写入启动日志：%@\n%@", logURL.path, error.localizedDescription], nil);
            return 1;
        }
        [log seekToEndOfFile];
        NSString *entry = [NSString stringWithFormat:@"\n%@ 正在启动 EventLens：%@\n", NSDate.date, root.path];
        [log writeData:[entry dataUsingEncoding:NSUTF8StringEncoding]];

        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:@"/bin/bash"];
        // 独立参数传递，中文、空格、引号和 shell 特殊字符均无需转义。
        task.arguments = @[[root.path stringByAppendingPathComponent:@"start.sh"], @"--desktop"];
        task.currentDirectoryURL = root;
        task.environment = environment;
        task.standardInput = NSFileHandle.fileHandleWithNullDevice;
        task.standardOutput = log;
        task.standardError = log;
        if (![task launchAndReturnError:&error]) {
            [log closeFile];
            showFailure(error.localizedDescription, logURL);
            return 1;
        }
        [task waitUntilExit];
        [log closeFile];
        if (task.terminationStatus != 0) {
            showFailure(@"启动器未能完成启动，请查看日志中的具体原因。", logURL);
        }
        return task.terminationStatus;
    }
}

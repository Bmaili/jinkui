package app.jinkui.local;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.assist.AssistStructure;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.service.autofill.Dataset;
import android.view.autofill.AutofillManager;
import android.view.autofill.AutofillValue;
import android.widget.RemoteViews;
import app.jinkui.local.autofill.AutofillLog;
import app.jinkui.local.autofill.FieldParser;
import android.view.autofill.AutofillId;
import com.getcapacitor.JSArray;
import app.jinkui.local.autofill.JinkuiAutofillService;
import app.jinkui.local.autofill.PendingSaves;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 自动填充（规格 5.8）。主界面用它查询、开启系统设置；自动填充窗口用它拿到请求、交回结果。
 *
 * JS：registerPlugin('Autofill')
 *   status() → { supported, enabled }
 *   openSettings() → { opened }       打开“把金匮设为自动填充服务”的系统弹窗
 *   disable()                          不再使用金匮作为自动填充服务
 *   getRequest() → { mode: 'fill' | 'save' | null, packageName, appLabel, webDomain, hasUsername, hasPassword, username?, password? }
 *   fill({ username?, password? })     把选中的账号密码交回系统并关闭窗口
 *   close()                            取消并关闭窗口
 */
@CapacitorPlugin(name = "Autofill")
public class AutofillPlugin extends Plugin {

    private FieldParser.Result fillTarget;
    private PendingSaves.Save save;
    private boolean loaded;
    /** 已经把结果交回系统 */
    private boolean answered;

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        boolean supported = false;
        boolean enabled = false;
        if (Build.VERSION.SDK_INT >= 26) {
            AutofillManager m = getContext().getSystemService(AutofillManager.class);
            if (m != null) {
                supported = m.isAutofillSupported();
                enabled = m.hasEnabledAutofillServices();
            }
        }
        ret.put("supported", supported);
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        JSObject ret = new JSObject();
        boolean opened = false;
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData(Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                opened = true;
            } catch (ActivityNotFoundException ignored) {
                // 部分系统没有这个弹窗：网页上会显示手动设置的步骤
            } catch (Exception ignored) {
                // 同上
            }
        }
        ret.put("opened", opened);
        call.resolve(ret);
    }

    @PluginMethod
    public void disable(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26) {
            AutofillManager m = getContext().getSystemService(AutofillManager.class);
            if (m != null && m.hasEnabledAutofillServices()) m.disableAutofillServices();
        }
        call.resolve();
    }

    @TargetApi(Build.VERSION_CODES.O)
    private void readRequest() {
        if (loaded) return;
        loaded = true;
        Activity a = getActivity();
        if (a == null || a.getIntent() == null || Build.VERSION.SDK_INT < 26) return;
        Intent i = a.getIntent();
        String mode = i.getStringExtra(JinkuiAutofillService.EXTRA_MODE);
        if ("fill".equals(mode)) {
            // 优先用填充请求时认出的输入框（和系统这次会话里的标识一致）；没有时才重新解析页面
            AutofillId u = i.getParcelableExtra(JinkuiAutofillService.EXTRA_USERNAME_ID);
            AutofillId p = i.getParcelableExtra(JinkuiAutofillService.EXTRA_PASSWORD_ID);
            String source;
            if (u != null || p != null) {
                fillTarget = new FieldParser.Result();
                fillTarget.usernameId = u;
                fillTarget.passwordId = p;
                fillTarget.packageName = i.getStringExtra(JinkuiAutofillService.EXTRA_PACKAGE);
                fillTarget.webDomain = i.getStringExtra(JinkuiAutofillService.EXTRA_DOMAIN);
                source = "随请求";
            } else {
                AssistStructure s = i.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE);
                fillTarget = s != null ? FieldParser.parse(s) : null;
                source = s != null ? "重新解析页面" : "没有页面结构";
            }
            AutofillLog.add(getContext(), "填充窗口打开（输入框来源：" + source + "；等待结果：" + (a.getCallingActivity() != null ? "是" : "否") + "）"
                + (fillTarget != null ? " " + AutofillLog.describe(fillTarget) : ""));
        } else if ("save".equals(mode)) {
            save = PendingSaves.take(i.getStringExtra(JinkuiAutofillService.EXTRA_TOKEN));
            AutofillLog.add(getContext(), "保存窗口打开" + (save == null ? "（内容已过期，app 进程可能被回收过）" : ""));
        }
    }

    private String labelOf(String pkg) {
        if (pkg == null) return null;
        try {
            PackageManager pm = getContext().getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            CharSequence l = pm.getApplicationLabel(info);
            return l == null ? pkg : l.toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    @PluginMethod
    public void getRequest(PluginCall call) {
        readRequest();
        JSObject ret = new JSObject();
        if (fillTarget != null && !fillTarget.isEmpty()) {
            ret.put("mode", "fill");
            ret.put("packageName", fillTarget.packageName);
            ret.put("appLabel", labelOf(fillTarget.packageName));
            ret.put("webDomain", fillTarget.webDomain);
            ret.put("hasUsername", fillTarget.usernameId != null);
            ret.put("hasPassword", fillTarget.passwordId != null);
        } else if (save != null) {
            ret.put("mode", "save");
            ret.put("packageName", save.packageName);
            ret.put("appLabel", labelOf(save.packageName));
            ret.put("webDomain", save.webDomain);
            ret.put("hasUsername", save.username != null);
            ret.put("hasPassword", true);
            ret.put("username", save.username);
            ret.put("password", save.password);
        } else {
            ret.put("mode", (String) null);
        }
        call.resolve(ret);
    }

    @PluginMethod
    @TargetApi(Build.VERSION_CODES.O)
    public void fill(final PluginCall call) {
        readRequest();
        if (fillTarget == null || fillTarget.isEmpty()) {
            AutofillLog.add(getContext(), "交回结果失败：没有要填充的输入框");
            call.reject("没有要填充的输入框");
            return;
        }
        String username = call.getString("username");
        String password = call.getString("password");
        RemoteViews p = new RemoteViews(getContext().getPackageName(), R.layout.autofill_item);
        p.setTextViewText(R.id.autofill_text, "金匮");
        Dataset.Builder b = new Dataset.Builder();
        boolean any = false;
        if (fillTarget.usernameId != null && username != null) {
            b.setValue(fillTarget.usernameId, AutofillValue.forText(username), p);
            any = true;
        }
        if (fillTarget.passwordId != null && password != null) {
            b.setValue(fillTarget.passwordId, AutofillValue.forText(password), p);
            any = true;
        }
        if (!any) {
            AutofillLog.add(getContext(), "交回结果失败：这一条没有可以填的内容");
            call.reject("这一条没有可以填的内容");
            return;
        }
        final boolean filledUser = fillTarget.usernameId != null && username != null;
        final boolean filledPass = fillTarget.passwordId != null && password != null;
        final Dataset dataset = b.build();
        final Activity a = getActivity();
        a.runOnUiThread(() -> {
            Intent reply = new Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset);
            a.setResult(Activity.RESULT_OK, reply);
            answered = true;
            AutofillLog.add(getContext(), "交回填充结果（账号=" + (filledUser ? "有" : "无") + " 密码=" + (filledPass ? "有" : "无")
                + "），由系统填入" + (a.getCallingActivity() == null ? "；注意：窗口不是被系统以“等待结果”方式打开的，结果可能交不回去" : ""));
            call.resolve();
            a.finish();
        });
    }

    @PluginMethod
    public void diagnostics(PluginCall call) {
        JSObject ret = new JSObject();
        JSArray arr = new JSArray();
        for (String l : AutofillLog.lines(getContext())) arr.put(l);
        ret.put("lines", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearDiagnostics(PluginCall call) {
        AutofillLog.clear(getContext());
        call.resolve();
    }

    /** 网页端的诊断信息也记到同一份记录里（填充窗口的网页环境用完就没了） */
    @PluginMethod
    public void log(PluginCall call) {
        String m = call.getString("message", "");
        if (m != null && !m.isEmpty()) AutofillLog.add(getContext(), "[网页] " + m);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (fillTarget != null || save != null) {
            if (!answered) AutofillLog.add(getContext(), "窗口关闭" + (save != null ? "（保存窗口）" : "（没有交回填充结果）"));
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void close(final PluginCall call) {
        final Activity a = getActivity();
        a.runOnUiThread(() -> {
            a.setResult(Activity.RESULT_CANCELED);
            call.resolve();
            a.finish();
        });
    }
}

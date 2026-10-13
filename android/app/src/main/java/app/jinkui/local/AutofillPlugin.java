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
import app.jinkui.local.autofill.FieldParser;
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
    private void load() {
        if (loaded) return;
        loaded = true;
        Activity a = getActivity();
        if (a == null || a.getIntent() == null || Build.VERSION.SDK_INT < 26) return;
        Intent i = a.getIntent();
        String mode = i.getStringExtra(JinkuiAutofillService.EXTRA_MODE);
        if ("fill".equals(mode)) {
            AssistStructure s = i.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE);
            if (s != null) fillTarget = FieldParser.parse(s);
        } else if ("save".equals(mode)) {
            save = PendingSaves.take(i.getStringExtra(JinkuiAutofillService.EXTRA_TOKEN));
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
        load();
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
        load();
        if (fillTarget == null || fillTarget.isEmpty()) {
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
            call.reject("这一条没有可以填的内容");
            return;
        }
        final Dataset dataset = b.build();
        final Activity a = getActivity();
        a.runOnUiThread(() -> {
            Intent reply = new Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset);
            a.setResult(Activity.RESULT_OK, reply);
            call.resolve();
            a.finish();
        });
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

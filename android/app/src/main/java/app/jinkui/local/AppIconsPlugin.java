package app.jinkui.local;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.util.HashSet;
import java.util.Set;

/**
 * 本机已装 app 的名字和图标（1.0.8 起，规格 5.9）。全部在本机读，不联网。
 * 安卓 11 起只看得到清单里 queries 声明的 app（桌面上有图标的 app），不需要 QUERY_ALL_PACKAGES。
 *
 * JS：registerPlugin('AppIcons')
 *   listApps() → { apps: [{ packageName, label }] }   桌面上有图标的 app（不含金匮自己）
 *   icons({ packages, size }) → { icons: { 包名: data:image/png;base64,… } }   没装的 app 不返回
 */
@CapacitorPlugin(name = "AppIcons")
public class AppIconsPlugin extends Plugin {

    /** 一次最多取多少个图标（列表滚动时分批取） */
    private static final int MAX_BATCH = 60;

    @PluginMethod
    public void listApps(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        JSArray arr = new JSArray();
        Set<String> seen = new HashSet<>();
        String self = getContext().getPackageName();
        try {
            for (ResolveInfo ri : pm.queryIntentActivities(i, 0)) {
                if (ri.activityInfo == null) continue;
                String pkg = ri.activityInfo.packageName;
                if (pkg == null || pkg.equals(self) || !seen.add(pkg)) continue;
                CharSequence l = ri.loadLabel(pm);
                JSObject o = new JSObject();
                o.put("packageName", pkg);
                o.put("label", l == null ? pkg : l.toString());
                arr.put(o);
            }
        } catch (Exception e) {
            // 个别系统会拒绝查询：当作没有
        }
        JSObject ret = new JSObject();
        ret.put("apps", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void icons(PluginCall call) {
        JSArray pkgs = call.getArray("packages");
        int size = Math.max(32, Math.min(192, call.getInt("size", 96)));
        PackageManager pm = getContext().getPackageManager();
        JSObject out = new JSObject();
        int n = pkgs == null ? 0 : Math.min(pkgs.length(), MAX_BATCH);
        for (int k = 0; k < n; k++) {
            try {
                String pkg = pkgs.getString(k);
                Drawable d = pm.getApplicationIcon(pkg);
                Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
                Canvas c = new Canvas(b);
                d.setBounds(0, 0, size, size);
                d.draw(c);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                b.compress(Bitmap.CompressFormat.PNG, 100, bos);
                b.recycle();
                out.put(pkg, "data:image/png;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            } catch (Exception e) {
                // 没装、读不出来：跳过这一个
            }
        }
        JSObject ret = new JSObject();
        ret.put("icons", out);
        call.resolve(ret);
    }
}

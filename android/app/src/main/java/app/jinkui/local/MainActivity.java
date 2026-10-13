package app.jinkui.local;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 默认禁止截屏、录屏，最近任务里也看不到内容（规格 6.4）；设置里关掉后由 PrivacyScreenPlugin 清除
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        // 本工程自带的原生插件，要在 super.onCreate 之前注册
        registerPlugin(VaultKeyPlugin.class);
        registerPlugin(PrivacyScreenPlugin.class);
        registerPlugin(SecureClipboardPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}

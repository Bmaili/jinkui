package app.jinkui.local;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

/**
 * 自动填充窗口（规格 5.8）：系统在用户点“用金匮填充”或“保存到金匮”时打开它。
 * 和主界面是两个独立的网页环境：每次打开都要重新解锁，填好或保存后就关掉，回到原来的 app。
 * 网页通过 AutofillPlugin 知道自己处在哪种模式，见 src/autofillMain.ts。
 */
public class AutofillActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        registerPlugin(VaultKeyPlugin.class);
        registerPlugin(PrivacyScreenPlugin.class);
        registerPlugin(AutofillPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

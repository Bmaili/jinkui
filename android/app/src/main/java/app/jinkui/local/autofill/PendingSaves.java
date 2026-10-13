package app.jinkui.local.autofill;

import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 登录后“保存到金匮”的内容，只放在本进程的内存里，用一次性的令牌交给保存窗口；
 * 不把密码放进 Intent（Intent 会经过系统进程）。10 分钟没用就丢掉。
 */
public final class PendingSaves {

    public static final class Save {
        public String packageName;
        public String webDomain;
        public String username;
        public String password;
        final long created = System.currentTimeMillis();
    }

    private static final long TTL = 10 * 60 * 1000;
    private static final Map<String, Save> SAVES = new ConcurrentHashMap<>();

    private PendingSaves() {}

    public static String put(Save s) {
        long now = System.currentTimeMillis();
        for (Iterator<Map.Entry<String, Save>> it = SAVES.entrySet().iterator(); it.hasNext(); ) {
            if (now - it.next().getValue().created > TTL) it.remove();
        }
        String token = UUID.randomUUID().toString();
        SAVES.put(token, s);
        return token;
    }

    /** 取出并删除 */
    public static Save take(String token) {
        return token == null ? null : SAVES.remove(token);
    }
}

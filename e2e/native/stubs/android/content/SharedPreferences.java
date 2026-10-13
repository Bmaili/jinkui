package android.content; public interface SharedPreferences {
  String getString(String k, String d);
  interface Editor { Editor putString(String k, String v); Editor remove(String k); void apply(); }
  Editor edit(); }

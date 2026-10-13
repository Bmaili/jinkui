package android.app.assist; public class AssistStructure implements android.os.Parcelable {
  public static class WindowNode { public ViewNode getRootViewNode(){ return null; } }
  public static class ViewNode {
    public int getVisibility(){ return 0; } public int getChildCount(){ return 0; } public ViewNode getChildAt(int i){ return null; }
    public String getWebDomain(){ return null; } public android.view.autofill.AutofillId getAutofillId(){ return null; }
    public int getAutofillType(){ return 0; } public String getClassName(){ return null; } public android.view.ViewStructure.HtmlInfo getHtmlInfo(){ return null; }
    public String getIdEntry(){ return null; } public String getHint(){ return null; } public String[] getAutofillHints(){ return null; }
    public int getInputType(){ return 0; } public android.view.autofill.AutofillValue getAutofillValue(){ return null; } }
  public android.content.ComponentName getActivityComponent(){ return null; }
  public int getWindowNodeCount(){ return 0; } public WindowNode getWindowNodeAt(int i){ return null; } }

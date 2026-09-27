"""Show PNG pictures inline in the chat (ChatGPT Python tool).

Images drawn by the Python tool with matplotlib appear right in the answer, unlike files, which
ChatGPT turns into attachments. Usage inside the Python tool:

    exec(open('<skill>/scripts/show.py').read())
    show('/mnt/data/lego/out/rocket-model.png')                # one picture
    show('/mnt/data/lego/out/rocket-steps.png', width=9)       # wider, for the step sheet
"""


def show(*paths, width=6.0):
    import os
    for p in paths:
        p = os.path.abspath(p)
        if not os.path.exists(p):
            print('no such picture:', p)
            continue
        try:
            import matplotlib
            import matplotlib.pyplot as plt
            import matplotlib.image as mpimg
            img = mpimg.imread(p)
            h, w = img.shape[:2]
            fig = plt.figure(figsize=(width, width * h / w), dpi=110)
            ax = fig.add_axes([0, 0, 1, 1])
            ax.imshow(img)
            ax.axis('off')
            plt.show()
            plt.close(fig)
        except Exception:
            try:
                from IPython.display import Image, display
                display(Image(filename=p))
            except Exception as e:  # no display in this sandbox: the caller falls back to markdown
                print('cannot display inline:', e)
